# Third-party notices for Excalidraw Workbench

The Excalidraw Workbench webview bundles open-source browser code into `webview/runtime/` so install scripts can copy the extension without running npm on user machines. `webview/runtime/PROVENANCE.json` records the direct runtime dependency versions and the exact regeneration command.

Runtime dependencies are tracked in `webview/package-lock.json`. Recreate the committed runtime files with:

```bash
cd extensions/excalidraw-workbench/webview
npm ci
npm run build
```

The build also writes provenance, copies Excalidraw runtime assets, and scans the bundle for high-confidence secret patterns. At the time this notice was added, the bundled runtime tree is:

| Package | License |
| --- | --- |
| `@excalidraw/excalidraw` | MIT |
| `react` | MIT |
| `react-dom` | MIT |
| `scheduler` | MIT |
| `loose-envify` | MIT |
| `js-tokens` | MIT |

## Excalidraw

Excalidraw is licensed under the MIT License.

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
