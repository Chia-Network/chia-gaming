FROM node:20.18.1
RUN apt-get update -y
RUN apt-get install -y libc6
RUN apt-get install -y python3 python3-dev python3-pip python3-venv clang curl build-essential
RUN apt-get update
RUN npm install -g corepack
RUN yarn set version 1.22.22
WORKDIR /app
RUN python3 -m venv ./test
RUN sh -c ". /app/test/bin/activate && python3 -m pip install chia-blockchain==2.5.5-rc3"
# Gross, check the hash at least.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs > rustup.sh && sh ./rustup.sh -y
RUN echo 'source $HOME/.cargo/env' >> $HOME/.profile
ENV PATH="/root/.cargo/bin:${PATH}"
RUN . $HOME/.cargo/env && rustup default stable && rustup target add wasm32-unknown-unknown --toolchain stable && cargo +stable install --version 0.13.1 wasm-pack
ADD clsp /app/clsp

# Setup pre-build the dependencies
RUN mkdir -p /app/rust/src
COPY Cargo.toml /app/rust/Cargo.toml
COPY Cargo.lock /app/rust/Cargo.lock
RUN sh -c "echo > /app/rust/src/lib.rs"

# Setup pre-build wasm
RUN mkdir -p /app/rust/wasm/src
COPY wasm/Cargo.toml /app/rust/wasm/Cargo.toml
COPY wasm/Cargo.lock /app/rust/wasm/Cargo.lock
RUN sh -c "echo > /app/rust/wasm/src/mod.rs"

# Pre-build
RUN cd /app/rust && . $HOME/.cargo/env && . /app/test/bin/activate && pip install maturin==1.9.2
RUN cd /app/rust && . $HOME/.cargo/env && . /app/test/bin/activate && maturin build --release --features sim-tests

RUN . $HOME/.cargo/env && cd /app/rust/wasm && wasm-pack build --out-dir=/app/rust/wasm/node-pkg --release --target=nodejs
RUN mv /app/rust/wasm/node-pkg /app
RUN . $HOME/.cargo/env && cd /app/rust/wasm && wasm-pack build --out-dir=/app/rust/wasm/pkg --release --target=web

#Stage front-end / UI / UX into the container
COPY resources/gaming-fe/package.json /app
COPY resources/gaming-fe/yarn.lock /app
RUN cd /app && yarn install

ADD src /app/rust/src
RUN touch /app/rust/src/lib.rs

ADD wasm/src /app/rust/wasm/src
RUN touch /app/rust/wasm/src/mod.rs

# Build
RUN cd /app/rust && . $HOME/.cargo/env && . /app/test/bin/activate && maturin build --release --features sim-tests
RUN cd /app/rust && . $HOME/.cargo/env && . /app/test/bin/activate && rm -rf `find . -name \*manylinux1_x86_64.whl` && pip install `find . -name \*.whl`

RUN . $HOME/.cargo/env && cd /app/rust/wasm && wasm-pack build --out-dir=/app/rust/wasm/node-pkg --release --target=nodejs
RUN rm -rf /app/node-pkg
RUN mv /app/rust/wasm/node-pkg /app
RUN . $HOME/.cargo/env && cd /app/rust/wasm && wasm-pack build --out-dir=/app/rust/wasm/pkg --release --target=web

# Place wasm backend in docker container
RUN mkdir -p /app/dist
RUN cp /app/rust/wasm/pkg/chia_gaming_wasm_bg.wasm /app/dist/chia_gaming_wasm_bg.wasm
RUN cp /app/rust/wasm/pkg/chia_gaming_wasm.js /app/dist/chia_gaming_wasm.js

# Build the front-end / UI / UX within the container env
COPY resources/gaming-fe /app
RUN cd /app && yarn run build

COPY resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex /app/resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex
RUN ln -s /app/resources /resources
ADD clsp /app/clsp
RUN ln -s /app/clsp /clsp
COPY resources/gaming-fe/package.json /app/package.json
RUN (echo 'from chia_gaming import chia_gaming' ; echo 'chia_gaming.service_main()') > run_simulator.py
CMD /bin/sh -c "(node ./dist/lobby-rollup.cjs &) && (sleep 10 ; node ./dist/server-rollup.cjs --self http://localhost:3000 --tracker http://localhost:3001 &) && . /app/test/bin/activate && python3 run_simulator.py"
