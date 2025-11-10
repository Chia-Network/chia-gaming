FROM node:20.18.1 AS stage1
ENV PATH="/root/.cargo/bin:${PATH}"
RUN apt-get update -y && \
    apt-get install -y libc6 && \
    apt-get install -y python3 python3-dev python3-pip python3-venv clang curl build-essential nginx && \
    npm install -g corepack && \
    yarn set version 1.22.22 && \
    python3 -m venv /app/test && \
    . /app/test/bin/activate && \
    pip install maturin==1.9.2 && \
    sh -c ". /app/test/bin/activate && python3 -m pip install chiavdf==1.1.12 chia-blockchain==2.5.5-rc3" && \
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

# Lobby connection - needed by other builds
COPY resources/lobby-connection/ /app/lobby-connection/
RUN mkdir -p /preinst && cd /app/lobby-connection && yarn install && yarn build && mv /app/lobby-connection /preinst

# Stage front-end / UI / UX into the container
COPY resources/gaming-fe/package.json resources/gaming-fe/yarn.lock /preinst/game/

# Lobby front-end
COPY resources/lobby-view/package.json resources/lobby-view/yarn.lock /preinst/lobby-view/

# Lobby service
COPY resources/lobby-service/package.json resources/lobby-service/yarn.lock /preinst/lobby-service/

# walletconnect automation
COPY resources/wc-stub/package.json resources/wc-stub/yarn.lock /preinst/wc/

RUN --mount=type=tmpfs,dst=/app \
  mkdir -p /app/game/ && \
  cp -r /preinst/lobby-connection /app/lobby-connection && \
  cp -r /preinst/game/* /app/game/ && \
  ls -l /app && ls -l /app/lobby-connection && ls -l /preinst/lobby-connection && \
  cd /app/game && yarn install && \
  mv /app/game/node_modules /preinst/game/ && \
  mv /app/game/package.json /preinst/game/ 

RUN --mount=type=tmpfs,dst=/app \
  mkdir -p /app/lobby-view/ && \
  cp -r /preinst/lobby-connection /app/lobby-connection && \
  cp -r /preinst/lobby-view/* /app/lobby-view/ && \
  cd /app/lobby-view && yarn install && \
  mv /app/lobby-view/node_modules /preinst/lobby-view && \
  mv /app/lobby-view/package.json /preinst/lobby-view

#CI FROM node:20.18.1 AS stage2
#CI RUN apt-get update -y && \
#CI     apt-get install -y libc6 && \
#CI     apt-get install -y python3 python3-dev python3-pip python3-venv clang curl build-essential && \
#CI     apt-get update && \
#CI     npm install -g corepack && \
#CI     yarn set version 1.22.22
#CI COPY --from=stage1 /preinst /preinst
#CI COPY --from=stage1 /root /root
#CI COPY --from=stage1 /app /app

RUN --mount=type=tmpfs,dst=/app \
  mkdir -p /app/lobby-service/ && \
  cp -r /preinst/lobby-service/* /app/lobby-service/ && \
  cd /app/lobby-service && yarn install && \
  mv /app/lobby-service/node_modules /preinst/lobby-service && \
  mv /app/lobby-service/package.json /preinst/lobby-service

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
#CI COPY --from=stage2 /preinst /preinst
#CI COPY --from=stage2 /root /root
#CI COPY --from=stage2 /app /app

RUN mkdir -p /app/game/ && mkdir -p /app/wc/ && mkdir -p /app/lobby-service/ && mkdir -p /app/lobby-connection && mkdir -p /app/lobby-view && \
  ln -s /preinst/game/node_modules /app/game/ && \
  ln -s /preinst/game/package.json /app/game/ && \
  ln -s /preinst/lobby-service/node_modules /app/lobby-service && \
  ln -s /preinst/lobby-service/package.json /app/lobby-service && \
  ln -s /preinst/lobby-view/node_modules /app/lobby-view && \
  ln -s /preinst/lobby-view/package.json /app/lobby-view && \
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
	wasm-pack build --out-dir=/app/game/node-pkg --release --target=nodejs && \
	wasm-pack build --out-dir=/app/game/dist --release --target=web

# Place wasm backend in docker container
RUN mkdir -p /app/dist

# Build the front-end / UI / UX within the container env
COPY resources/gaming-fe /app/game/
RUN cd /app/game && yarn run build && \
  cp -r /app/game/dist /app && \
  cp -r /app/game/public /app

# Build the lobby view
COPY resources/lobby-view /app/lobby-view/
RUN cd /app/lobby-view && yarn run build

# lobby service
COPY resources/lobby-service/src /app/lobby-service/src/
COPY resources/lobby-service/tsconfig.json /app/lobby-service/
RUN cd /app/lobby-service && yarn run build

# walletconnect automation build
COPY resources/wc-stub/src /app/wc/src/
COPY resources/wc-stub/tsconfig.json /app/wc/
RUN cd /app/wc && yarn run build

RUN ln -s /app/game/resources /resources
ADD clsp /app/game/clsp
RUN ln -s /app/game/clsp /clsp
COPY resources/gaming-fe/package.json /app/package.json
COPY resources/nginx/game.conf /etc/nginx/sites-enabled
COPY resources/nginx/lobby.conf /etc/nginx/sites-enabled
COPY resources/nginx/urls /app/dist
COPY resources/nginx/beacon.sh /app

RUN (echo 'from chia_gaming import chia_gaming' ; echo 'chia_gaming.service_main()') > /app/run_simulator.py
COPY resources/fe-test/scripts/test_env.sh /app

CMD /bin/bash /app/test_env.sh
