# DevGlobe+

### Features

- Disabled links to repositories you can't access (private repositories or repositories you don't have permission to view).
- Added tooltips to indicate which country and language each flag represents.
- Added sortable stats tables on the [/stats](https://devglobe.app/stats) page.
- Search focus shortcut: press any letter (a-z) or digit (0-9) on [/space](https://devglobe.app/space), [/plugins](https://devglobe.app/plugins), [/projects](https://devglobe.app/projects), or [/developers](https://devglobe.app/developers) to auto-focus the search input.

### Installation
1. Open the browser extensions page.
2. Enable developer mode.
3. Load this folder as an unpacked extension.

### Target pages
- [https://devglobe.app/space](https://devglobe.app)
- [https://devglobe.xyz/space](https://devglobe.xyz/space)
- [https://devglobe.app/plugins*](https://devglobe.app/plugins)
- [https://devglobe.xyz/plugins*](https://devglobe.xyz/plugins)
- [https://devglobe.app/projects*](https://devglobe.app/projects)
- [https://devglobe.xyz/projects*](https://devglobe.xyz/projects)
- [https://devglobe.app/stats](https://devglobe.app/stats)
- [https://devglobe.xyz/stats](https://devglobe.xyz/stats)
- [https://devglobe.app/developers/*](https://devglobe.app/developers/)
- [https://devglobe.xyz/developers/*](https://devglobe.xyz/developers/)

### Notes
- No external API is used.
- Repository checks are performed with native `fetch` calls from the service worker.
- Repository link state is cache-first, then refreshed in the background when needed.
- the extension popup is available from the toolbar icon. It provides quick access to the [DevGlobe website](https://devglobe.app).

## Credits

- [DevGlobe](https://devglobe.app) is developed and maintained by [CaadriFR](https://github.com/CaadriFR) and [Nakooo](https://github.com/Nako0).  
- Icons are made by [TagSteel](https://github.com/TagSteel).
