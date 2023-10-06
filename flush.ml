exception Unexpected

type suit = S of int

type rank = R of int

type count_and_suit = CS of (int * int)

type compressed_card = CC of int

let find_flush (suits : compressed_card) =
  let CS (count1, suit1) = group_by_count_clean (atomsort suits) in
  suit1 * (5 >= count1)

module Rank = struct
  type t = rank

  let zero = R 0

  let non_nil = function
    | R 0 -> false
    | _ -> true

  let eq (a : t) (b : t) = Pervasives.compare a b == 0

  let pred = function
    | R n -> R (n - 1)

  let add (amt : int) = function
    | R n -> R (n + amt)
end

let rec straight_high_inner (ranks : rank list) (last : rank) (count : int) : rank =
  match ranks with
  | [] ->
    (* maybe ace to 5 *)
    if (Rank.eq last (R 2)) && (count == 4) then
      5
    else
      0
  | f_ranks :: r_ranks ->
    if (Rank.eq last f_ranks) then
      (* skip identical cards *)
      straight_high_inner r_ranks last count
      (* if the partial straight continues *)
    else if (Rank.eq f_ranks (Rank.pred last)) then
      if count == 4 then
        (* found a straight, add 3 to last because next and last are included *)
        Rank.add 3 last
      else
        (* keep looking for a straight with the count going up to one *)
        straight_high_inner r_ranks f_ranks (count + 1)
    else
      straight_high_inner r_ranks f_ranks 1

(* returns the high card of a straight or 0 if there isn't any
   ranks must be sorted in descending order *)
let straight_high_extended : (rank list -> rank) =
  function
  | [] -> raise Unexpected
  | f_ranks :: _ ->
    let high = straight_high_inner ranks Rank.zero 0 in
    if Rank.eq high (R 5) then
      if Rank.eq f_ranks (R 14) then
        R 5
      else
        R 0
    else
      high
