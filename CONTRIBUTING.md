# Contributing to YouTube Music Remover

Thank you for your interest in contributing! 🎉

## Getting Started

1. Fork the repo and clone it locally
2. Load the extension in Chrome or Comet Browser Developer Mode
3. Make your changes and test them on YouTube

## Development Setup

```bash
git clone https://github.com/YOUR_USERNAME/youtube-music-remover.git
cd youtube-music-remover
```

Then load the folder as an unpacked extension in `chrome://extensions/`.

## Guidelines

- **Code style**: Use clear, descriptive variable names and add comments for complex logic
- **Testing**: Manually test on YouTube with multiple video types (music videos, podcasts, lectures)
- **Commits**: Use clear commit messages (e.g., `feat: add French translation`, `fix: audio sync on live streams`)
- **PRs**: Describe what your change does and include screenshots if it affects the UI

## Translation Guide

To add a new language:

1. Open `i18n.js`
2. Copy the `en` object and create a new key (e.g., `fr`, `tr`, `ur`)
3. Translate all string values
4. Add the language option to the `<select>` in `popup.html`
5. Test RTL if your language requires it

## Reporting Bugs

Open an issue with:
- Browser version (Chrome or Comet Browser)
- Extension version
- Steps to reproduce
- YouTube video URL (if relevant)
- Console errors (right-click extension → Inspect)

## Code of Conduct

Be respectful, inclusive, and constructive. We're all here to build something good.
