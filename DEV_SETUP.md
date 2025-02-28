
--> This is a lot of space about setting up commit signing, which isn't
strictly necessary. I'd recommend moving this info elsewhere.

# Setting up git

First, you'll need to set up commit signing.


```bash

# install gpg on macos
brew install gpg

# Set git to sign all commits by default
git config --global commit.gpgsign true
```

--> gpg probably isn't considered best practices anymore. GPG had its day, and
those days are mostly over. Github supports ssh signing, and I think that's
probably a better thing since everyone needs ssh anyway and not everyone needs
gpg. Use `age` instead of gpg for encryption.

## Find the verified email address for your GitHub account here:
https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-email-preferences/verifying-your-email-address

```bash
# Create a new gpg key -- make sure to use you verified github email
gpg --full-generate-key
# https://docs.github.com/en/authentication/managing-commit-signature-verification/generating-a-new-gpg-key

# Get the ID for your GPG secret key
# In the example below, it is '3AA5C34371567BD2'

$ gpg --list-secret-keys --keyid-format=long
/Users/<you>/.gnupg/secring.gpg
------------------------------------
sec   4096R/3AA5C34371567BD2 2016-03-10 [expires: 2017-03-10]
uid                          You <you@example.com>
ssb   4096R/4BB6D45482678BE3 2016-03-10

# Print the GPG public key in ASCII armor format
gpg --armor --export <YOUR_ID e.g. 3AA5C34371567BD2>
```
## Add your GPG signing key to your github account
https://docs.github.com/en/authentication/managing-commit-signature-verification/adding-a-gpg-key-to-your-github-account#adding-a-gpg-key


# Setting up your development environment

Now that you have git signing set up, let's set up the repo.

## Check out the repo

```bash
cd
git clone git@github.com:Chia-Network/chia-gaming.git
cd chia-gaming
```

## Install Rust
```bash
# If you have the brew-installed tools, remove them
brew remove llvm maturin

# Install rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Set the rust compiler to the bleeding edge, so we can use certain libraries
rustup toolchain install nightly
# rustup default nightly
^^^^^^^^^^^^^^^^^^^^^^^^ <-- don't do this. It's global and affects everything,
and could very much confuse the user. If you need nightly, say so in your
`rust-toolchain.toml` file in the root of your directory. See
https://rust-lang.github.io/rustup/overrides.html#the-toolchain-file

Also, state explicitly what features of nightly you need, probably as comments
in the .toml file. The goal is to eventually move to stable once all the
features from nightly you need have migrated to stable. Using nightly makes it
much harder to build reproducible builds
```

## Check the build
```bash
cargo test
```
