FROM node:20.0.0
RUN apt-get update -y
RUN apt-get install -y libc6
RUN apt-get install -y python3 python3-dev python3-pip python3-venv clang curl build-essential
RUN apt-get update
WORKDIR /app
RUN python3 -m venv ./test
RUN sh -c ". /app/test/bin/activate && python3 -m pip install chia-blockchain==2.3.0"
# Gross, check the hash at least.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs > rustup.sh && sh ./rustup.sh -y
RUN echo 'source $HOME/.cargo/env' >> $HOME/.profile
ENV PATH="/root/.cargo/bin:${PATH}"
RUN . $HOME/.cargo/env && rustup default stable && rustup target add wasm32-unknown-unknown --toolchain stable && cargo +stable install --version 0.13.1 wasm-pack
ADD clsp /app/clsp
RUN mkdir -p /app/rust/src
COPY Cargo.toml /app/rust/Cargo.toml
COPY Cargo.lock /app/rust/Cargo.lock
ADD src /app/rust/src
RUN cd /app/rust && . $HOME/.cargo/env && . /app/test/bin/activate && cargo build --release --features=server,simulator && cp ./target/release/chia-gaming /app
ADD wasm /app/rust/wasm
RUN . $HOME/.cargo/env && cd /app/rust/wasm && wasm-pack build --release --target=web

#Stage front-end / UI / UX into the container
COPY resources/gaming-fe /app

# Place wasm backend in docker container
RUN mkdir -p /app/dist
RUN cp /app/rust/wasm/pkg/chia_gaming_wasm_bg.wasm /app/dist/chia_gaming_wasm_bg.wasm
RUN cp /app/rust/wasm/pkg/chia_gaming_wasm.js /app/dist/chia_gaming_wasm.js

# Build the front-end / UI / UX within the container env
RUN cd /app && npm install
RUN cd /app && npm run build

COPY resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex /app/resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex
ADD clsp /app/clsp
COPY resources/gaming-fe/package.json /app/package.json
CMD /bin/sh -c "(. /app/test/bin/activate && ./chia-gaming &) && (node ./dist/lobby-rollup.cjs &) && npm run start"
