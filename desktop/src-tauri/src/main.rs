// pi desktop 外壳
//
// 只负责四件事，业务逻辑一行都不碰（那些都在被拉起的 Node 服务里）：
//   1. 从 app 包里找到内置的 node 与 pi-web 运行时
//   2. 拉起 `node bin/pi-web.js -p <port> --no-open`
//   3. 先显示启动页，等服务开始监听端口后把窗口导航过去
//   4. 退出时把服务收干净
//
// 之所以要一个 Rust 壳而不是直接用浏览器：pi-web 需要一个真实的 Node 进程
// 来跑 next、node-pty、以及 pi 的 agent 循环。

use std::fs::File;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 固定端口而不是随机端口：origin 稳定，localStorage 里的主题、面板宽度
/// 这些客户端状态才能跨启动保留。只有该端口被占用时才退到系统分配的空闲端口
/// （代价是那一次启动会换 origin）。
const PREFERRED_PORT: u16 = 30145;

const SERVER_START_TIMEOUT: Duration = Duration::from_secs(120);
const POLL_INTERVAL: Duration = Duration::from_millis(120);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// 被拉起服务端的句柄。放在 tauri 的 managed state 里，退出时取出来收尾。
struct ServerProcess(Mutex<Option<Child>>);

/// 首选端口能用就用它，不能用时先看看占着的是不是「上一次没被收干净的
/// pi-web 服务」——是就收掉它再复用同一端口。
///
/// 为什么要这么麻烦：origin 变了（端口不同就是不同 origin），localStorage 里的
/// 主题、面板宽度这些客户端状态就没了。而 app 被强杀 / 崩溃 / 注销时，
/// Rust 的退出清理是来不及跑的（SIGTERM 直接结束了进程），孤儿服务很常见。
///
/// 身份核对看命令行里的 pi-web，而不是看端口有没有响应 —— 宁可退到随机端口，
/// 也不能误杀用户其它程序。
fn pick_port() -> u16 {
    if port_is_free(PREFERRED_PORT) {
        return PREFERRED_PORT;
    }
    if reclaim_preferred_port() {
        return PREFERRED_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(PREFERRED_PORT)
}

/// 返回占用指定端口的监听进程号（macOS 自带 lsof）。
fn listening_pids(port: u16) -> Vec<i32> {
    let Ok(out) = Command::new("/usr/sbin/lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .collect()
}

fn command_line_of(pid: i32) -> String {
    Command::new("/bin/ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default()
}

fn reclaim_preferred_port() -> bool {
    let pids = listening_pids(PREFERRED_PORT);
    let ours: Vec<i32> = pids
        .into_iter()
        .filter(|pid| command_line_of(*pid).contains("pi-web"))
        .collect();
    if ours.is_empty() {
        return false;
    }
    for pid in &ours {
        let _ = Command::new("/bin/kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
    }
    for _ in 0..24 {
        if port_is_free(PREFERRED_PORT) {
            eprintln!("[pi-web-desktop] 接管了上次残留的服务（{ours:?}）");
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// 打包链路（rsync 复制、Tauri 打包资源）可能丢掉可执行位。
/// 丢了的话 node 起不来、node-pty 的 spawn-helper 也会失败（终端就用不了），
/// 所以启动前无条件确认一遍。
fn ensure_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(meta) = std::fs::metadata(path) else {
            return;
        };
        let mut perm = meta.permissions();
        if perm.mode() & 0o111 == 0o111 {
            return;
        }
        perm.set_mode(perm.mode() | 0o755);
        let _ = std::fs::set_permissions(path, perm);
    }
}

fn wait_until_listening(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).is_ok() {
            return true;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    false
}

/// 端口是不是空的（能绑上就是空的）。
fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// 给子进程一个像样的 PATH。从 Finder 启动的 app 只有
/// /usr/bin:/bin:/usr/sbin:/sbin，agent 调 rg / git 时会找不到。
fn child_path(runtime: &Path) -> std::ffi::OsString {
    let mut parts: Vec<PathBuf> = vec![runtime.join("bin")];
    if let Ok(existing) = std::env::var("PATH") {
        parts.extend(std::env::split_paths(&existing));
    }

    // 用户级工具目录。从 Finder 启动的 app 只有 /usr/bin:/bin:/usr/sbin:/sbin，
    // 而 agent 经常要跑 rustup/cargo、pipx、自己装的 CLI —— 它们都在这些目录里。
    // （曾经只有下面的系统目录，于是 app 里跑的 agent 连 cargo 都找不到。）
    if let Ok(home) = std::env::var("HOME") {
        for relative in [".cargo/bin", ".local/bin", ".bun/bin", ".volta/bin"] {
            parts.push(PathBuf::from(format!("{home}/{relative}")));
        }
    }

    for extra in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        parts.push(PathBuf::from(extra));
    }
    std::env::join_paths(parts)
        .unwrap_or_else(|_| std::ffi::OsString::from("/usr/bin:/bin:/usr/sbin:/sbin"))
}

fn stop_server(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ServerProcess>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    let Some(mut child) = guard.take() else {
        return;
    };

    // 用 SIGTERM 而不是 child.kill()（那是 SIGKILL）：pi-web.js 会把信号转发给
    // 它拉起的 `next start`。SIGKILL 没有机会处理，会把 next 留成孤儿进程占着端口。
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(child.id().to_string())
        .status();

    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(60)),
            Err(_) => break,
        }
    }
    // 没能在宽限期内退出，那就强杀
    let _ = child.kill();
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let runtime = resource_dir.join("runtime");
            let node = runtime.join("bin").join("node");
            let app_dir = runtime.join("app");
            let entry = app_dir.join("bin").join("pi-web.js");

            ensure_executable(&node);
            for rel in [
                "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
                "node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
                "node_modules/node-pty/build/Release/spawn-helper",
            ] {
                ensure_executable(&app_dir.join(rel));
            }

            // 服务端日志留在 ~/Library/Logs/<bundle id>/server.log，起不来时有据可查
            let log_path = match app.path().app_log_dir() {
                Ok(dir) => {
                    let _ = std::fs::create_dir_all(&dir);
                    Some(dir.join("server.log"))
                }
                Err(_) => None,
            };

            let port = pick_port();
            let mut child: Option<Child> = None;

            if entry.exists() {
                let mut cmd = Command::new(&node);
                cmd.arg(&entry)
                    .arg("-p")
                    .arg(port.to_string())
                    .arg("--no-open")
                    .current_dir(&app_dir)
                    .env("PI_WEB_NO_OPEN", "1")
                    .env("PI_WEB_SKIP_VERSION_CHECK", "1")
                    .env("PATH", child_path(&runtime))
                    .stdin(Stdio::null());

                match log_path.as_ref().and_then(|p| File::create(p).ok()) {
                    Some(file) => {
                        match file.try_clone() {
                            Ok(clone) => cmd.stdout(Stdio::from(file)).stderr(Stdio::from(clone)),
                            Err(_) => cmd.stdout(Stdio::from(file)).stderr(Stdio::null()),
                        };
                    }
                    None => {
                        cmd.stdout(Stdio::null()).stderr(Stdio::null());
                    }
                }

                match cmd.spawn() {
                    Ok(handle) => child = Some(handle),
                    Err(err) => eprintln!("[pi-web-desktop] 拉起服务失败: {err}"),
                }
            } else {
                eprintln!(
                    "[pi-web-desktop] 找不到运行时入口: {}（app 包可能不完整）",
                    entry.display()
                );
            }

            app.manage(ServerProcess(Mutex::new(child)));

            // 窗口先建出来显示启动页，避免等服务时是一片空白。
            // 不要原生标题栏：窗口内容占满整窗，macOS 红绿灯直接叠进左栏顶部
            // 那一行左边的空位（左栏本来就是按这个留的空）。
            // Overlay 不会真的去掉 titlebar，所以从顶部那一条拖动窗口依旧可用。
            //
            // traffic_light_position 的第二个参数不是「距顶部的距离」。
            // AppKit 是左下原点，tao 只改按钮的 X（见 tao 的 inset_traffic_lights：
            // setFrameOrigin 里 Y 用原值），所以按钮会随这个值整体下移 —— 实测斜率
            // 正好是 1（y 36→26 时，截图上位置也下移了 10pt）。
            //
            // 逐次实测标定（目标 = 左栏那行 48px 里控件的垂直中心，距顶 24pt）：
            //   y=14 → 太靠上；y=36 → 太下面；y=26 → 偏低；y=22 → 仍偏低一点点；故取 20。
            // 每减 1，红绿灯上移 1pt（斜率实测为 1）。
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("pi desktop")
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(20.0, 20.0))
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(900.0, 600.0)
                    .center()
                    .build()?;

            let navigator = window.clone();
            std::thread::spawn(move || {
                if !wait_until_listening(port, SERVER_START_TIMEOUT) {
                    eprintln!("[pi-web-desktop] 服务在 {SERVER_START_TIMEOUT:?} 内没有开始监听");
                    return;
                }
                match format!("http://127.0.0.1:{port}/").parse() {
                    Ok(url) => {
                        if let Err(err) = navigator.navigate(url) {
                            eprintln!("[pi-web-desktop] 导航失败: {err}");
                        }
                    }
                    Err(err) => eprintln!("[pi-web-desktop] 地址不合法: {err}"),
                }
            });

            Ok(())
        })
        // 关窗口 ≠ 退出程序（macOS 习惯）：点红灯或按 ⌘W 只是把窗口收起来，
        // 程序与后台服务继续跑（agent 可以在后台继续干活），点程序坞图标再把窗口放回来。
        // 真正退出是 ⌘Q 或程序坞右键 → 退出，那时才进 RunEvent::Exit 收掉服务。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("构建 tauri 应用失败")
        .run(|app, event| match event {
            // 点程序坞图标（可能一个窗口都没显示）→ 把窗口放回来
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            // 真正退出时才收掉服务
            tauri::RunEvent::Exit => stop_server(app),
            _ => {}
        });
}
