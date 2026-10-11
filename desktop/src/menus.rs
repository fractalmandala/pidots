//! The macOS menu bar and its keyboard shortcuts.
//!
//! Edit commands (copy, paste, cut, select all) are native menu items that
//! AppKit sends to the focused view, so they work inside the WebView. The
//! shortcuts are bound in a key context nothing in the window uses: GPUI shows
//! them in the menu but never consumes the keystroke itself, so AppKit routes it
//! through the menu bar as in any Mac app.

use gpui_kit::*;

use crate::Shell;

actions!(
    pidots,
    [
        Quit,
        Hide,
        HideOthers,
        ShowAll,
        OpenProviders,
        Cut,
        Copy,
        Paste,
        SelectAll,
        Undo,
        Redo,
        Reload,
        Back,
        Forward,
        ShowDataFolder,
        Minimize,
        Zoom,
        CloseWindow,
    ]
);

const MENU_ONLY: Option<&str> = Some("PidotsMenuOnly");

pub fn install(shell: Entity<Shell>, cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, MENU_ONLY),
        KeyBinding::new("cmd-h", Hide, MENU_ONLY),
        KeyBinding::new("alt-cmd-h", HideOthers, MENU_ONLY),
        KeyBinding::new("cmd-,", OpenProviders, MENU_ONLY),
        KeyBinding::new("cmd-x", Cut, MENU_ONLY),
        KeyBinding::new("cmd-c", Copy, MENU_ONLY),
        KeyBinding::new("cmd-v", Paste, MENU_ONLY),
        KeyBinding::new("cmd-a", SelectAll, MENU_ONLY),
        KeyBinding::new("cmd-z", Undo, MENU_ONLY),
        KeyBinding::new("shift-cmd-z", Redo, MENU_ONLY),
        KeyBinding::new("cmd-r", Reload, MENU_ONLY),
        KeyBinding::new("cmd-[", Back, MENU_ONLY),
        KeyBinding::new("cmd-]", Forward, MENU_ONLY),
        KeyBinding::new("cmd-m", Minimize, MENU_ONLY),
        KeyBinding::new("cmd-w", CloseWindow, MENU_ONLY),
    ]);

    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    // Closing the only window quits, like the red button.
    cx.on_action(|_: &CloseWindow, cx| cx.quit());
    cx.on_action(|_: &Minimize, cx| with_window(cx, |window| window.minimize_window()));
    cx.on_action(|_: &Zoom, cx| with_window(cx, |window| window.zoom_window()));

    // The WebView handles these through its page; GPUI never sees them as text.
    let script = |shell: &Entity<Shell>, js: &'static str| {
        let shell = shell.clone();
        move |cx: &mut App| shell.update(cx, |shell, cx| shell.eval(js, cx))
    };
    let undo = script(&shell, "document.execCommand('undo')");
    cx.on_action(move |_: &Undo, cx| undo(cx));
    let redo = script(&shell, "document.execCommand('redo')");
    cx.on_action(move |_: &Redo, cx| redo(cx));
    let back = script(&shell, "history.back()");
    cx.on_action(move |_: &Back, cx| back(cx));
    let forward = script(&shell, "history.forward()");
    cx.on_action(move |_: &Forward, cx| forward(cx));
    let providers = script(&shell, "location.hash = '#providers'");
    cx.on_action(move |_: &OpenProviders, cx| providers(cx));
    cx.on_action(|_: &ShowDataFolder, _| crate::server::reveal(&crate::server::data_dir()));
    let reload = shell.clone();
    cx.on_action(move |_: &Reload, cx| reload.update(cx, |shell, cx| shell.reload_page(cx)));

    cx.set_menus([
        Menu::new("Pidots").items([
            MenuItem::action("Providers & Keys…", OpenProviders),
            MenuItem::separator(),
            MenuItem::action("Hide Pidots", Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit Pidots", Quit),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", Undo, OsAction::Undo),
            MenuItem::os_action("Redo", Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", Cut, OsAction::Cut),
            MenuItem::os_action("Copy", Copy, OsAction::Copy),
            MenuItem::os_action("Paste", Paste, OsAction::Paste),
            MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("View").items([
            MenuItem::action("Reload", Reload),
            MenuItem::action("Back", Back),
            MenuItem::action("Forward", Forward),
            MenuItem::separator(),
            MenuItem::action("Show Data Folder and Logs", ShowDataFolder),
        ]),
        Menu::new("Window").items([
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", Zoom),
            MenuItem::separator(),
            MenuItem::action("Close", CloseWindow),
        ]),
    ]);
}

fn with_window(cx: &mut App, f: impl FnOnce(&mut Window)) {
    if let Some(window) = cx.windows().first().copied() {
        let _ = window.update(cx, |_, window, _| f(window));
    }
}
