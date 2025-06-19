FROM node:20.0.0
WORKDIR /app
ADD resources/gaming-fe/dist /app/dist
ADD resources/gaming-fe/public /app/public
COPY resources/gaming-fe/package.json /app/package.json
ADD wasm/pkg/chia_gaming_wasm_bg.wasm /app/dist/chia_gaming_wasm_bg.wasm
ADD wasm/pkg/chia_gaming_wasm.js /app/dist/chia_gaming_wasm.js
CMD /bin/sh -c "(node ./dist/lobby-rollup.cjs &) && npm run start"
