FROM node:20.0.0
WORKDIR /app
ADD dist /app/dist
COPY package.json /app/package.json
CMD /bin/sh -c "(node ./dist/lobby-rollup.cjs &) && npm run start"
