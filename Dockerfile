FROM node:20.0.0
WORKDIR /app
ADD resources/gaming-fe/dist /app/dist
ADD resources/gaming-fe/public /app/public
COPY resources/gaming-fe/package.json /app/package.json
CMD /bin/sh -c "(node ./dist/lobby-rollup.cjs &) && npm run start"
