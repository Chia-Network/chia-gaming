
# Setting up git

First, you'll need to set up commit signing.


`bash

# install gpg on macos
brew install gpg

# Set git to sign all commits by default
git config --global commit.gpgsign true

# Find the verified email address for your GitHub account here:
https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-email-preferences/verifying-your-email-address

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

# Add your GPG signing key to your github account
https://docs.github.com/en/authentication/managing-commit-signature-verification/adding-a-gpg-key-to-your-github-account#adding-a-gpg-key
`

# Setting up your development environment

Now that you have git signing set up, let's set up the repo.

## Check out the repo

`bash
$ cd
$ git clone git@github.com:Chia-Network/chia-gaming.git
$ cd chia-gaming
`

## Install Rust
`
brew install llvm maturin
rustup toolchain install nightly
rustup default nightly
`

## Check the build
`cargo test
`