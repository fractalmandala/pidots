//! Pidots desktop shell.
//!
//! A GPUI Kit window with a native toolbar and a Wry WebView that hosts the
//! Pidots web UI. The shell starts the bundled Node server on a free
//! loopback port, waits for it, then points the WebView at it. Provider keys
//! are configured inside the app (Providers dialog), never through `.env`.

mod computers;
mod menus;
mod server;

use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Sizable as _, StyledExt as _, Theme, TitleBar,
    button::{Button, ButtonVariants as _},
    h_flex, v_flex,
};
use gpui_kit::*;
use gpui_wry::WebView;
use computers::{Computers, ComputersConfig};
use server::{Server, ServerConfig};

#[derive(Clone, PartialEq)]
enum Status {
    Starting,
    Ready,
    Failed(String),
}

pub struct Shell {
    focus_handle: FocusHandle,
    webview: Entity<WebView>,
    server: Option<Server>,
    computers: Option<Computers>,
    status: Status,
    _poll: Option<Task<()>>,
}

impl Shell {
    fn new(window: &mut Window, cx: &mut App) -> Entity<Self> {
        let webview = cx.new(|cx| {
            use raw_window_handle::HasWindowHandle as _;
            let handle = window.window_handle().expect("No window handle");
            let builder = wry::WebViewBuilder::new()
                .with_html(LOADING_HTML)
                .with_navigation_handler(server::allow_navigation)
                .with_new_window_req_handler(|url, _features| {
                    // `target="_blank"` links (setup guides, provider key pages)
                    // open in the user's browser instead of a new WebView.
                    server::open_external(&url);
                    wry::NewWindowResponse::Deny
                });
            #[cfg(any(debug_assertions, feature = "inspector"))]
            let builder = builder.with_devtools(true);
            let native = builder
                .build_as_child(&handle)
                .expect("Failed to create WebView");
            WebView::new(native, window, cx)
        });

        cx.new(|cx| {
            let mut this = Self {
                focus_handle: cx.focus_handle(),
                webview,
                server: None,
                computers: None,
                status: Status::Starting,
                _poll: None,
            };
            this.start_server(cx);
            this
        })
    }

    /// The WebView is a native view drawn above GPUI content, so it must be
    /// hidden whenever the failure screen replaces it in the layout.
    fn set_status(&mut self, status: Status, cx: &mut App) {
        let visible = !matches!(status, Status::Failed(_));
        self.status = status;
        self.webview.update(cx, |view, _| {
            if visible {
                view.show()
            } else {
                view.hide()
            }
        });
    }

    fn start_server(&mut self, cx: &mut Context<Self>) {
        if let Some(mut previous) = self.server.take() {
            previous.stop();
        }
        // Computers are optional: if the helper is missing or fails, Pidots
        // still runs and the Computer panel says they are unavailable.
        if self.computers.is_none() {
            self.computers = ComputersConfig::discover().and_then(|config| {
                Computers::spawn(&config)
                    .inspect_err(|error| eprintln!("Built-in computers unavailable: {error:#}"))
                    .ok()
            });
        }
        self.set_status(Status::Starting, cx);
        let config = match ServerConfig::discover() {
            Ok(config) => config,
            Err(error) => {
                self.set_status(Status::Failed(format!("{error:#}")), cx);
                cx.notify();
                return;
            }
        };
        let computers_file = self.computers.as_ref().map(|c| c.server_file.clone());
        match Server::spawn(&config, computers_file.as_deref()) {
            Ok(server) => {
                let url = server.url();
                let port = server.port();
                self.server = Some(server);
                self._poll = Some(cx.spawn(async move |this, cx| {
                    for _ in 0..240 {
                        cx.background_executor()
                            .timer(Duration::from_millis(250))
                            .await;
                        let exited = this
                            .update(cx, |this, _| {
                                this.server.as_mut().and_then(Server::exit_status)
                            })
                            .ok()
                            .flatten();
                        if let Some(code) = exited {
                            let _ = this.update(cx, |this, cx| {
                                this.set_status(
                                    Status::Failed(format!(
                                        "The Pidots server exited ({code}). See the log in {}.",
                                        server::data_dir().display()
                                    )),
                                    cx,
                                );
                                cx.notify();
                            });
                            return;
                        }
                        if server::is_listening(port) {
                            let _ = this.update(cx, |this, cx| {
                                this.set_status(Status::Ready, cx);
                                this.webview.update(cx, |view, _| view.load_url(&url));
                                cx.notify();
                            });
                            return;
                        }
                    }
                    let _ = this.update(cx, |this, cx| {
                        this.set_status(
                            Status::Failed("The Pidots server did not start in 60 seconds.".into()),
                            cx,
                        );
                        cx.notify();
                    });
                }));
            }
            Err(error) => self.set_status(Status::Failed(format!("{error:#}")), cx),
        }
        cx.notify();
    }

    pub fn eval(&self, script: &str, cx: &mut Context<Self>) {
        let _ = self.webview.read(cx).raw().evaluate_script(script);
    }

    fn go_back(&mut self, _: &ClickEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.eval("history.back()", cx);
    }

    fn go_forward(&mut self, _: &ClickEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.eval("history.forward()", cx);
    }

    fn reload(&mut self, _: &ClickEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.reload_page(cx);
    }

    /// Reloads the page, or restarts the server when it is not running.
    pub fn reload_page(&mut self, cx: &mut Context<Self>) {
        match self.status {
            Status::Ready => {
                let _ = self.webview.read(cx).raw().reload();
            }
            _ => self.start_server(cx),
        }
    }

    fn open_providers(&mut self, _: &ClickEvent, _: &mut Window, cx: &mut Context<Self>) {
        // The web app opens its Providers dialog for this hash.
        self.eval("location.hash = '#providers'", cx);
    }

    fn reveal_data(&mut self, _: &ClickEvent, _: &mut Window, _: &mut Context<Self>) {
        server::reveal(&server::data_dir());
    }

    fn stop_server(&mut self) {
        if let Some(mut server) = self.server.take() {
            server.stop();
        }
        if let Some(mut computers) = self.computers.take() {
            computers.stop();
        }
    }
}

impl Focusable for Shell {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (dot, label) = match &self.status {
            Status::Starting => (theme.warning, "Starting…"),
            Status::Ready => (theme.success, "Running"),
            Status::Failed(_) => (theme.danger, "Stopped"),
        };
        let ready = self.status == Status::Ready;

        let toolbar = TitleBar::new().child(
            h_flex()
                .w_full()
                .pr_2()
                .gap_1()
                .items_center()
                .justify_between()
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(div().text_sm().font_semibold().child("Pidots"))
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(concat!("v", env!("CARGO_PKG_VERSION"))),
                        )
                        .child(
                            h_flex()
                                .gap_1()
                                .items_center()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(div().size_2().rounded_full().bg(dot))
                                .child(label),
                        ),
                )
                .child(
                    h_flex()
                        .gap_1()
                        .items_center()
                        .child(
                            Button::new("back")
                                .ghost()
                                .small()
                                .icon(IconName::ChevronLeft)
                                .tooltip("Back")
                                .disabled(!ready)
                                .on_click(cx.listener(Self::go_back)),
                        )
                        .child(
                            Button::new("forward")
                                .ghost()
                                .small()
                                .icon(IconName::ChevronRight)
                                .tooltip("Forward")
                                .disabled(!ready)
                                .on_click(cx.listener(Self::go_forward)),
                        )
                        .child(
                            Button::new("reload")
                                .ghost()
                                .small()
                                .icon(IconName::RefreshCw)
                                .tooltip(if ready { "Reload" } else { "Restart server" })
                                .on_click(cx.listener(Self::reload)),
                        )
                        .child(
                            Button::new("data")
                                .ghost()
                                .small()
                                .icon(IconName::FolderOpen)
                                .tooltip("Show data folder and logs")
                                .on_click(cx.listener(Self::reveal_data)),
                        )
                        .child(
                            Button::new("providers")
                                .small()
                                .icon(IconName::KeyRound)
                                .label("Providers")
                                .disabled(!ready)
                                .on_click(cx.listener(Self::open_providers)),
                        ),
                ),
        );

        let body = match &self.status {
            Status::Failed(message) => v_flex()
                .flex_1()
                .items_center()
                .justify_center()
                .gap_3()
                .p_8()
                .child(div().text_lg().font_semibold().child("Pidots could not start"))
                .child(
                    div()
                        .max_w(px(560.))
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(message.clone()),
                )
                .child(
                    Button::new("retry")
                        .primary()
                        .label("Try again")
                        .on_click(cx.listener(Self::reload)),
                )
                .into_any_element(),
            _ => div()
                .flex_1()
                .size_full()
                .child(self.webview.clone())
                .into_any_element(),
        };

        v_flex()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(toolbar)
            .child(body)
    }
}

const LOADING_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; font: 14px -apple-system, system-ui, sans-serif; }
  body { display: grid; place-items: center; background: Canvas; color: GrayText; }
  .dots { display: flex; gap: 8px; justify-content: center; margin-bottom: 14px; }
  .dots span { width: 10px; height: 10px; border-radius: 50%; animation: pulse 1.2s infinite ease-in-out; }
  .dots span:nth-child(1) { background: #5b8def; }
  .dots span:nth-child(2) { background: #3ccf9e; animation-delay: .15s; }
  .dots span:nth-child(3) { background: #f59e42; animation-delay: .3s; }
  .dots span:nth-child(4) { background: #a77bf3; animation-delay: .45s; }
  @keyframes pulse { 0%, 100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
</style></head>
<body><div><div class="dots"><span></span><span></span><span></span><span></span></div>Starting Pidots…</div></body></html>"#;

fn main() {
    let app = gpui_kit::application();
    app.with_assets(gpui_kit::assets::Assets).run(move |cx| {
        gpui_kit::init(cx);

        let bounds = Bounds::centered(None, size(px(1280.), px(840.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitleBar::title_bar_options()),
            window_min_size: Some(size(px(720.), px(480.))),
            app_id: Some("com.pidots.desktop".into()),
            ..Default::default()
        };
        let (_, shell) = gpui_kit::open_window(options, cx, |window, cx| {
            // Follow macOS light/dark mode, like the web UI's "System" theme.
            Theme::sync_system_appearance(Some(window), cx);
            window
                .observe_window_appearance(|window, cx| {
                    Theme::sync_system_appearance(Some(window), cx)
                })
                .detach();
            Shell::new(window, cx)
        })
        .expect("Failed to open window");

        menus::install(shell.clone(), cx);

        let on_quit = shell.clone();
        cx.on_app_quit(move |cx| {
            on_quit.update(cx, |shell, _| shell.stop_server());
            async {}
        })
        .detach();
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
    });
}
