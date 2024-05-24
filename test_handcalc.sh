#!/bin/sh

time ../target/debug/run -i . resources/test_handcalc_micro.clsp && \
    ../target/debug/cldb -y main.sym -p -x resources/test_handcalc_micro.hex "$(opc '("handcalc" ((12 . 1) (11 . 1) (14 . 1) (13 . 1) (10 . 1) (9 . 1)))')"
