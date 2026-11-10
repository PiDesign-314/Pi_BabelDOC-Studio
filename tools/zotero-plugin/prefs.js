// BabelDOC Studio <-> Zotero bridge — default preferences.
//
// Zotero 7 reads this file from the add-on root on install/enable and on every
// start (the old defaults/preferences/ directory is not used by bootstrapped
// add-ons).  The pane in prefs.xhtml writes user values on top of these.
pref("extensions.babeldoc.launchInfoPath", "");
pref("extensions.babeldoc.appPath", "");
// The port stays a *string* on purpose: Zotero's preference-pane binding writes
// form values as strings, and an int pref would reject it.  "" / "0" = auto.
pref("extensions.babeldoc.port", "");
pref("extensions.babeldoc.autoLaunch", true);
pref("extensions.babeldoc.passPage", true);
