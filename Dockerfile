from rust:1.81
workdir /opt
copy Cargo.toml /opt
copy resources /opt/resources
copy src /opt/src
run apt-get update -y
run apt-get install -y python3-virtualenv
run python3 -m virtualenv ./venv
run sh -c ". ./venv/bin/activate; python3 -m pip install chia-blockchain==2.3.0"
run patch -p1 < /opt/resources/main.diff
run sh -c ". ./venv/bin/activate; cargo build --features=server,simulator"
run echo "cd /opt; . ./venv/bin/activate; export RUST_BACKTRACE=1; exec cargo run --features=server,simulator auto" > /opt/serve.sh
copy clsp /opt/clsp
run chmod +x /opt/serve.sh
expose 5800
cmd /opt/serve.sh
