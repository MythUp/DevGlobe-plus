# DevGlobe Space Guards

Manifest V3 browser extension for DevGlobe.

Features:
- shows a custom JS tooltip on flags with the country name and language names;
- caches repository link states and blocks clicks when a check returns `404` or `503`;
- rescans the page regularly because DevGlobe mounts and unmounts the popup dynamically.

Installation:
1. Open the browser extensions page.
2. Enable developer mode.
3. Load this folder as an unpacked extension.

Target pages:
- `https://devglobe.app/space`
- `https://devglobe.xyz/space`

Notes:
- no external API is used;
- repository checks are performed with native `fetch` calls from the service worker;
- the extension popup is available from the toolbar icon.

## Credits

[DevGlobe](https://devglobe.app) is developed and maintained by [CaadriFR](https://github.com/CaadriFR) and [Nakooo](https://github.com/Nako0).