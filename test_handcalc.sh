#!/bin/sh

time run -i . test_handcalc.clsp > test_handcalc.clvm && \
    opc test_handcalc.clvm > test_handcalc.hex && \
    cldb -y main.sym -p -x test_handcalc.hex 80
