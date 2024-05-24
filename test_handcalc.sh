#!/bin/sh

rm -rf resources/test_handcalc_micro.hex && \
    time ../target/debug/run -i . resources/test_handcalc_micro.clsp 2>/dev/null && \
    ../target/debug/cldb -y main.sym -p -x resources/test_handcalc_micro.hex "$(opc '("handcalc" ((14 . 1) (6 . 1) (5 . 1) (4 . 1) (3 . 1) (2 . 1)))')"
