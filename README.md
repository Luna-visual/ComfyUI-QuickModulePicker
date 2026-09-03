# ComfyUI Quick Paste

Hold a hotkey to save and paste node selections as reusable snippets.

[![ComfyUI Quick Paste introduction](https://img.youtube.com/vi/Z4TXiX9lC5c/maxresdefault.jpg)](https://youtu.be/Z4TXiX9lC5c)

[Watch the introduction on YouTube](https://youtu.be/Z4TXiX9lC5c)

## Install

**ComfyUI Manager:** search `Quick Paste` / `ComfyUI-QuickModulePicker` (after it is listed).

**Manual:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Luna-visual/ComfyUI-QuickModulePicker
```

Restart ComfyUI, then hard-refresh the browser (`Ctrl+F5`).

## Usage

| Action | How |
|--------|-----|
| Open panel | Hold `` ` `` (key left of `1`, below Esc) |
| Keep open | Click inside the panel |
| Close | Click outside, or press Esc |
| Save selection | Enter a name → **Save selection** |
| Paste | Click a list item (or `1`–`9` / Enter) |
| Replace snippet | Double-click an item |
| Multi-select | Shift+click, then **Delete** |
| Team default | **Publish as default** / **Back to default** |
| Move panel | Drag the title bar |

Hotkey can be changed in **Settings → Quick Paste Hotkey**.

## Notes

- Personal list is stored in the browser (`localStorage`).
- Shared default list is `snippets.base.json` (for teams that share the same `custom_nodes` folder).
- Do not commit machine-local files such as `snippets.local.json`.

## License

Luna-visual Source License (Non-Sale): free to use (including in commercial projects);
you may not sell this plugin or include it in paid packs without permission.
See [LICENSE](LICENSE).
