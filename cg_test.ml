open Handcalc

let _ =
  let test_cards =
    [ Card.fast 14 1
    ; Card.fast 6 1
    ; Card.fast 5 1
    ; Card.fast 4 1
    ; Card.fast 3 1
    ; Card.fast 2 1
    ]
  in
  let bitmap = handcalc test_cards in
  let _ = print_endline (string_of_int bitmap) in
  ()
