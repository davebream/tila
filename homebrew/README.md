# Homebrew Tap Template

This directory contains the formula template for the `davebream/homebrew-tap` repository.

## Setup (one-time)

1. Create the `davebream/homebrew-tap` public repository on GitHub
2. Copy `Formula/tila.rb` to the tap repo's `Formula/` directory
3. Create a GitHub PAT with `repo` scope on `davebream/homebrew-tap`
4. Add the PAT as `TAP_GITHUB_TOKEN` secret in `davebream/tila` repository settings

## Usage

```bash
brew tap davebream/tap
brew install davebream/tap/tila
```

## Auto-update

The `.github/workflows/publish-tap.yml` workflow automatically updates the formula
in `davebream/homebrew-tap` whenever a new release is published.
