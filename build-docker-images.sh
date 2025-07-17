
# Build Chia Gaming Docker image
docker build --platform linux/amd64 --progress=plain -t chia-gaming-test .

# Build Lobby Service Docker image
(cd ./resources/gaming-fe/src/lobby; ls)

