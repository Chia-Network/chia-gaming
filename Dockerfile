FROM node:20.0.0
RUN apt-get update -y
RUN apt-get install -y python3 python3-dev python3-pip python3-venv clang
WORKDIR /app
RUN python3 -m venv ./test
RUN sh -c ". /app/test/bin/activate && python3 -m pip install chia-blockchain==2.3.0"
# Gross, check the hash at least.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs > rustup.sh && sh ./rustup.sh -y
RUN . $HOME/.cargo/env && rustup default stable && rustup target add wasm32-unknown-unknown --toolchain stable && cargo +stable install --version 0.13.1 wasm-pack
ADD clsp /app/clsp
RUN mkdir -p /app/rust/src
COPY Cargo.toml /app/rust/Cargo.toml
COPY Cargo.lock /app/rust/Cargo.lock
ADD src /app/rust/src
RUN cd /app/rust && . $HOME/.cargo/env && . /app/test/bin/activate && cargo build --release --features=server,simulator && cp ./target/release/chia-gaming /app
ADD wasm /app/rust/wasm
ENV LOCAL_WASM_BUILD=true
RUN echo local wasm build $LOCAL_WASM_BUILD
RUN if $LOCAL_WASM_BUILD ; then (. $HOME/.cargo/env && cd /app/rust/wasm && wasm-pack build --release --target=web) ; fi
RUN mkdir -p /app/dist
RUN cp /app/rust/wasm/pkg/chia_gaming_wasm_bg.wasm /app/dist/chia_gaming_wasm_bg.wasm
RUN cp /app/rust/wasm/pkg/chia_gaming_wasm.js /app/dist/chia_gaming_wasm.js
ADD resources/gaming-fe/dist /app/dist
ADD resources/gaming-fe/public /app/public
COPY resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex /app/resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex
ADD clsp /app/clsp
COPY resources/gaming-fe/package.json /app/package.json
CMD /bin/sh -c "(. /app/test/bin/activate && ./chia-gaming &) && (node ./dist/lobby-rollup.cjs &) && (node ./dist/server-rollup.cjs --self http://localhost:3000 --tracker http://localhost:3001)"
