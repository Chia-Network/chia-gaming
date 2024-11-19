import os
import shutil
import json
import tomllib

def edit_line(k, v, line):
    if line.strip().startswith(k):
        return f'{k} = {json.dumps(v)}\n'
    else:
        return line

def replace_line(file, k, v):
    res = []
    edit = False

    for line in file:
        l = line.strip()
        if l.startswith('[build-dependencies]'):
            edit = True
        elif l.startswith('['):
            edit = False

        if edit:
            res.append(edit_line(k, v, line))
        else:
            res.append(line)

    return res

def edit_cargo_toml(key):
    dev_toml = tomllib.load(open('chialisp-dev/dev.toml', 'rb'))

    lines = []
    with open('Cargo.toml','r') as cargo:
        lines = cargo.readlines()

    for k,v in dev_toml[key].items():
        lines = replace_line(lines, k, v)

    with open('Cargo.toml','w') as cargo:
        for l in lines:
            cargo.write(l)

def disable_chialisp_dev():
    os.unlink('build.rs')

    edit_cargo_toml('nodev')

def enable_chialisp_dev():
    shutil.copy('chialisp-dev/build.rs','build.rs')
    edit_cargo_toml('dev')

def toggle_chialisp_dev():
    build_rs_exists = False
    try:
        os.stat('build.rs')
        build_rs_exists = True
    except:
        build_rs_exists = False

    if build_rs_exists:
        disable_chialisp_dev()
    else:
        enable_chialisp_dev()

if __name__ == '__main__':
    toggle_chialisp_dev()
