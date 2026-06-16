class Tila < Formula
  desc "State-and-coordination engine for multi-machine agentic work"
  homepage "https://github.com/davebream/tila"
  version "0.2.7"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/davebream/tila/releases/download/v0.2.7/tila-darwin-arm64"
      sha256 "7c9985ae21b795c8891f7a706fe07d7c264f519a252fdb70b7bdce184a561ff2"
    end
    on_intel do
      url "https://github.com/davebream/tila/releases/download/v0.2.7/tila-darwin-x64"
      sha256 "b3aac961ac18a3a63ff4f9c94232da20c3ad7ec385af7c7449561d03dfc5211e"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/davebream/tila/releases/download/v0.2.7/tila-linux-arm64"
      sha256 "8368383145cc82cf41bc83b1547b6e06ecb8e4fed76114ab24b2c891e1c17faf"
    end
    on_intel do
      url "https://github.com/davebream/tila/releases/download/v0.2.7/tila-linux-x64"
      sha256 "f53dc0feb8f8340fdaf38ad2ab73e6ff6018b1d4bc293c1ad9c94d5bf80514d7"
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
