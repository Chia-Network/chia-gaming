
PLATFORM="linux/amd64"

# Build rust intermediate docker image
docker build -f Dockerfile.rust --platform "$PLATFORM" --progress=plain -t chia-gaming-rust .

# Build web intermediate docker image
docker build -f Dockerfile.web --platform "$PLATFORM" --progress=plain -t chia-gaming-web .

# Build Chia Gaming test Docker image
docker build -f Dockerfile.test --platform "$PLATFORM" --progress=plain -t chia-gaming-sim .

# Build Chia Gaming Docker image
docker build --platform linux/amd64 --progress=plain -t chia-gaming .

# TODO: Build Lobby Service Docker image
(cd ./resources/gaming-fe/src/lobby; ls)

