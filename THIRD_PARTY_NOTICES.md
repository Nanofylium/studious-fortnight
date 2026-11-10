# Third-party notices

Forja includes JavaScript ports of code from the projects below. Both are MIT-licensed; their notices follow.

## libebur128

Source: https://github.com/jiixyj/libebur128
Used in: `src/lib/audio/thirdparty/ebur128.js` (K-weighting, integrated loudness, loudness range, true peak)

```
Copyright (c) 2011 Jan Kokemüller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Airwindows

Source: https://github.com/airwindows/airwindows
Used in: `src/lib/audio/thirdparty/airwindows.js` (ClipOnly2, ToTape6)

```
MIT License

Copyright (c) 2018 Chris Johnson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Editor (npm packages)

The "Editar e gravar" view uses these packages unmodified, bundled from npm
into the editor's own chunk:

- waveform-playlist (`@waveform-playlist/browser`, `core`, `playout`,
  `recording`, `ui-components`, `engine`, `worklets`): MIT,
  https://github.com/naomiaro/waveform-playlist
- Tone.js (`tone`): MIT, https://github.com/Tonejs/Tone.js
- dnd kit (`@dnd-kit/*`): MIT, https://github.com/clauderic/dnd-kit
- styled-components: MIT, https://github.com/styled-components/styled-components
- waveform-data (dependency of waveform-playlist): **LGPL-3.0**,
  https://github.com/bbc/waveform-data.js. Used unmodified as a separate
  module; its source is at that address and Forja's own source is public, so
  the library can be replaced and the app rebuilt (LGPL-3.0 section 4).
  Full license text: `node_modules/waveform-data/LICENSE` after `npm install`.

Their full license texts ship inside each package in `node_modules/`.
