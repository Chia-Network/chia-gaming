def dbg_assert_eq(expected, actual, msg=""):
    if expected != actual:
        err_msg = f"\n{msg}:\nexpected={expected}\nactual={actual}\n"
        # print(err_msg)
        raise AssertionError(err_msg)

