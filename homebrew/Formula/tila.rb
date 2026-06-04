class Tila < Formula
  desc "State-and-coordination engine for multi-machine agentic work"
  homepage "https://github.com/davebream/tila"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/davebream/tila/releases/download/v0.1.0/tila-darwin-arm64"
      sha256 "PLACEHOLDER_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/davebream/tila/releases/download/v0.1.0/tila-darwin-x64"
      sha256 "PLACEHOLDER_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/davebream/tila/releases/download/v0.1.0/tila-linux-arm64"
      sha256 "PLACEHOLDER_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/davebream/tila/releases/download/v0.1.0/tila-linux-x64"
      sha256 "PLACEHOLDER_LINUX_X64"
    end
  end

  def install
    bin.install Dir["tila*"].first => "tila"
    chmod 0755, bin/"tila"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tila --version")
  end
end
