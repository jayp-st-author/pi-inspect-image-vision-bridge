# pi-inspect-image-vision-bridge

A local fork of `pi-inspect-image` that gives non-vision Pi chat models image understanding through a separately selected vision model.

This fork is based on the original `pi-inspect-image` extension by [Tan Jee Schuan](https://github.com/TanJeeSchuan/pi-inspect-image). Thanks to Tan for creating the original extension and making the image-inspection workflow available to the Pi community.

## What changed

- Attached/pasted images are automatically sent to the configured vision model when the active chat model does not support images.
- The vision response is inserted as text context, and the original image payload is removed before the selected chat model is called.
- `/setup-vision` uses Pi's built-in `ModelSelectorComponent`, including fuzzy search, model refresh, provider labels, and the same keyboard behavior as `/model`.
- The selected chat model is never changed when selecting a vision model.
- `inspect_image` still handles image paths and uses the same vision configuration.
- Existing manual `visionConfig.baseUrl` configurations remain supported through an OpenAI-compatible fallback request.

## Install

Requires Pi `0.84.1` or newer. Install the published package directly from GitHub; no clone, build step, or separate npm install is needed:

```bash
pi install git:github.com/jayp-st-author/pi-inspect-image-vision-bridge
```

To install it only for the current project, add `-l`:

```bash
pi install -l git:github.com/jayp-st-author/pi-inspect-image-vision-bridge
```

If Pi is already running, restart it after installation. Update the package later with:

```bash
pi update
```

## First-time setup

1. Authenticate at least one provider with a vision-capable model using Pi's normal `/login` flow.
2. Run `/setup-vision`.
3. Select the vision model from the searchable Pi model selector.

The selector is the same searchable selector Pi uses for `/model`; it is filtered to authenticated models whose input includes images. Your normal chat model is not changed.

Configuration is saved to the project at `.pi/settings.json`:

```json
{
  "visionConfig": {
    "provider": "openai",
    "model": "gpt-4o"
  }
}
```

`maxTokens` is optional. `baseUrl` is optional for custom OpenAI-compatible endpoints.

## Usage

With a non-vision model active, paste or attach an image and ask a question normally. The fork will:

1. Send the image and the user request to the selected vision model.
2. Add the returned description as `[Vision context ...]` to the user request.
3. Remove the image bytes before the request reaches the non-vision chat model.

For a file path, use the `inspect_image` tool or ask Pi to inspect the image. The extension will guide the model to the tool when the active model lacks image input.

## Providers and credentials

The selector uses Pi's model registry, so it supports any authenticated Pi provider that advertises `input: ["image"]`, including dynamically loaded providers such as LLM Gateway. Configure credentials through Pi's normal `/login` flow or `auth.json`.

For a manually configured OpenAI-compatible fallback:

```json
{
  "visionConfig": {
    "provider": "my-provider",
    "model": "my-vision-model",
    "baseUrl": "https://example.com",
    "maxTokens": 4096
  }
}
```

## Supported image files

PNG, JPEG, GIF, WebP, and BMP up to 20 MB.

## Requirements

- An authenticated vision-capable model for automatic attached-image handoff.

## Credits

- Original extension: [TanJeeSchuan/pi-inspect-image](https://github.com/TanJeeSchuan/pi-inspect-image)
