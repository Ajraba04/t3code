# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Browser → Browser profiles → Add profile**, then choose a browser under
**Import from**. Close the source browser before importing, and allow an operating-system keyring
unlock prompt if one appears.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag T3 Code into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen T3 Code before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

On Windows, import supports Firefox, Zen, and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.

## Extensions

The desktop app can load unpacked Chrome extensions into a browser profile. Open
**Settings → Browser → Extensions**, pick the profile, choose **Add folder**, and select the folder
that holds the extension's `manifest.json`. Use the switch to turn an extension off without
removing it. Changes apply to open tabs without restarting.

Extensions run in every tab of that profile, including tabs an agent opens, so they can change what
an agent sees, and an agent can read what they fill into a page. Use a separate profile for
extensions you don't want near agent work. Incognito never loads extensions.

T3 Code's browser supports only part of Chrome's extension API, mainly what developer tools
extensions use. Extensions that need toolbar popups, request blocking, or a companion desktop app
may load but not work. Packed `.crx` files and the Chrome Web Store are not supported. Web and
mobile clients use the server's browser, which does not load extensions.
