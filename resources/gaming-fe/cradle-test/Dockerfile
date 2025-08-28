FROM node:20.0.0
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

# Install Rust
RUN . $HOME/.cargo/env && rustup default stable && rustup target add wasm32-unknown-unknown --toolchain stable && cargo +stable install --version 0.13.1 wasm-pack

# Start copying over source
ADD clsp /app/clsp
ADD rust /app/rust

RUN . $HOME/.cargo/env && . /app/test/bin/activate && pip install maturin==1.9.2
RUN . $HOME/.cargo/env && . /app/test/bin/activate && cd /app/rust && maturin build --release --features sim-tests && pip install `find . -name \*.whl`

# Build Rust sources
RUN . $HOME/.cargo/env && cd /app/rust/wasm && wasm-pack build --release --target=nodejs
RUN cd /app/rust && . $HOME/.cargo/env && . /app/test/bin/activate && cargo build --release --features=sim-tests

# Place wasm backend in docker container
RUN mkdir -p /app/dist
RUN cp /app/rust/wasm/pkg/chia_gaming_wasm_bg.wasm /app/dist/chia_gaming_wasm_bg.wasm
RUN cp /app/rust/wasm/pkg/chia_gaming_wasm.js /app/dist/chia_gaming_wasm.js

# Install front-end UI / UX packages into the container env
COPY package.json yarn.lock /app/

RUN cd /app && yarn install

RUN (echo 'from chia_gaming import chia_gaming' ; echo 'chia_gaming.service_main()') > run_simulator.sh

# Stage front-end / UI / UX into the container
COPY .eslintrc.json babel.config.js tsconfig.json tstestconfig.json webpack.config.demo.js webpack.config.js /app/
ADD scripts /app/scripts
ADD src /app/src

RUN mkdir -p /app/resources
COPY ./resources/*.hex /app/resources/
COPY ./resources/*.hex /resources/
ADD clsp /clsp

RUN cd /app && yarn run build
CMD /bin/sh -c "(. /app/test/bin/activate && (sleep 1000 | python run_simulator.sh) &) && (cd /app && sleep 3 && yarn run test)"
