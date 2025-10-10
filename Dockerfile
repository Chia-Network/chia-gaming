FROM node:20.18.1 as stage1
ENV PATH="/root/.cargo/bin:${PATH}"
RUN apt-get update -y && \
    apt-get install -y libc6 && \
    apt-get install -y python3 python3-dev python3-pip python3-venv clang curl build-essential && \
    apt-get update && \
    npm install -g corepack && \
    yarn set version 1.22.22 && \
    python3 -m venv /app/test && \
    . /app/test/bin/activate && \
    pip install maturin==1.9.2 && \
    sh -c ". /app/test/bin/activate && python3 -m pip install chia-blockchain==2.5.5-rc3" && \
    : "# Gross, check the hash at least." && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs > rustup.sh && \
    sh ./rustup.sh -y && \
    echo 'source $HOME/.cargo/env' >> $HOME/.profile && \
    . $HOME/.cargo/env && \
    rustup default stable && \
    rustup target add wasm32-unknown-unknown --toolchain stable && cargo +stable install --version 0.13.1 wasm-pack && \
    mkdir -p /app/rust/src && mkdir -p /app/rust/wasm/src && \
    sh -c "echo > /app/rust/src/lib.rs" && \
    sh -c "echo > /app/rust/wasm/src/mod.rs"
    
WORKDIR /app
ADD clsp /app/clsp

# Setup to pre-build the dependencies
COPY rust-toolchain.toml Cargo.toml Cargo.lock /app/rust/

# Setup pre-build wasm
COPY wasm/Cargo.toml wasm/Cargo.lock /app/rust/wasm/

# Pre-build
RUN --mount=type=tmpfs,dst=/tmp/rust \
	(cd /app/rust && tar cf - .) | (cd /tmp/rust && tar xvf -) && \
	mkdir -p /tmp/rust/wasm && (cd /app/rust/wasm && tar cf - .) | (cd /tmp/rust/wasm && tar xf -) && \
	cd /tmp/rust && \
	. $HOME/.cargo/env && \
	. /app/test/bin/activate && \
	maturin build --features sim-tests && \
	cd /tmp/rust/wasm && \
	wasm-pack build --out-dir=/tmp/rust/wasm/node-pkg --release --target=nodejs && \
	wasm-pack build --out-dir=/tmp/rust/wasm/pkg --release --target=web && \
  rm -rf /tmp/rust/wasm/node-pkg /tmp/rust/wasm/pkg && \
	(cd /tmp/rust && tar cvf - .) | (cd /app/rust && tar xf -)

# Stage front-end / UI / UX into the container
COPY resources/gaming-fe/package.json resources/gaming-fe/yarn.lock /preinst/

# walletconnect automation
COPY resources/wc-stub/package.json resources/wc-stub/yarn.lock /preinst/wc/

RUN --mount=type=tmpfs,dst=/app \
  mkdir -p /app/wc/ && \
  cp -r /preinst/* /app && \
  cd /app && yarn install && \
  mv /app/node_modules /preinst/ && \
  mv /app/package.json /preinst/ 

RUN --mount=type=tmpfs,dst=/app \
  mkdir -p /app/wc/ && \
  cp -r /preinst/wc/* /app/wc/ && \
  cd /app/wc && yarn install && \
  mv /app/wc/node_modules /preinst/wc && \
  mv /app/wc/package.json /preinst/wc

#CI FROM node:20.18.1
#CI RUN apt-get update -y && \
#CI     apt-get install -y libc6 && \
#CI     apt-get install -y python3 python3-dev python3-pip python3-venv clang curl build-essential && \
#CI     apt-get update && \
#CI     npm install -g corepack && \
#CI     yarn set version 1.22.22
#CI COPY --from=stage1 /preinst /preinst
#CI COPY --from=stage1 /root /root
#CI COPY --from=stage1 /app /app

RUN mkdir -p /app/wc/ && \
  ln -s /preinst/node_modules /app && \
  ln -s /preinst/package.json /app && \
  ln -s /preinst/wc/node_modules /app/wc && \
  ln -s /preinst/wc/package.json /app/wc

ADD src /app/rust/src
RUN touch /app/rust/src/lib.rs

ADD wasm/src /app/rust/wasm/src
RUN touch /app/rust/wasm/src/mod.rs

# Build
RUN --mount=type=tmpfs,dst=/tmp/rust \
	(cd /app/rust/ && tar cvf - .) | (cd /tmp/rust && tar xf -) && \
	cd /tmp/rust && \
	rm -rf `find . -name \*.whl` && \
	. $HOME/.cargo/env && \
	. /app/test/bin/activate && \
	maturin build --features sim-tests && \
	pip install `find . -name \*.whl` && \
	cp -r /tmp/rust/target/wheels/* /app/rust/target/wheels && \
	cd /tmp/rust/wasm && \
	cargo clean -p chia_gaming_wasm && \
	wasm-pack build --out-dir=/app/node-pkg --release --target=nodejs && \
	wasm-pack build --out-dir=/app/dist --release --target=web

# Place wasm backend in docker container
RUN mkdir -p /app/dist

# Build the front-end / UI / UX within the container env
COPY resources/gaming-fe /app
RUN cd /app && yarn run build

# walletconnect automation build
COPY resources/wc-stub/src /app/wc/src/
COPY resources/wc-stub/tsconfig.json /app/wc/
RUN cd /app/wc && yarn run build

COPY resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex /app/resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex
RUN ln -s /app/resources /resources
ADD clsp /app/clsp
RUN ln -s /app/clsp /clsp
COPY resources/gaming-fe/package.json /app/package.json
RUN (echo 'from chia_gaming import chia_gaming' ; echo 'chia_gaming.service_main()') > /app/run_simulator.py
RUN echo 'cd /app && (node ./dist/lobby-rollup.cjs --self http://localhost:3001 &) && (sleep 10 ; node ./dist/server-rollup.cjs --self http://localhost:3000 --tracker http://localhost:3001 "${@}" &) && (cd /app/wc && node ./dist/index.js &) && . /app/test/bin/activate && RUST_LOG=debug python3 run_simulator.py' > /app/test_env.sh && chmod +x /app/test_env.sh
CMD /bin/bash /app/test_env.sh
