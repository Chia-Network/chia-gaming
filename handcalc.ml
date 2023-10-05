open Printf

exception Unexpected

type suit = S of int

type rank = R of int

type card = C of (rank * suit)

type count_and_suit = CS of (int * suit)

type count_and_rank = CR of (int * rank)

type compressed_card = CC of int

type compressed_count_and_suit = CCS of int

type compressed_count_and_rank = CCR of int

type rank_and_index = RI of (rank * int)

type compressed_rank_and_index = CRI of int

let atomsort (l : 'a list) =
  List.rev (List.sort Pervasives.compare l)

let rec truncate n (l : 'a list) =
  if n == 0 then
    []
  else
    match l with
    | [] -> []
    | hd :: tl -> hd :: (truncate (n - 1) tl)

module Rank = struct
  type t = rank

  let zero = R 0

  let make v = R v

  let non_nil = function
    | R 0 -> false
    | _ -> true

  let eq (a : t) (b : t) = Pervasives.compare a b == 0

  let pred = function
    | R n -> R (n - 1)

  let add (amt : int) = function
    | R n -> R (n + amt)

  let ord = function
    | R n -> n

  let str = function
    | R n -> "(rank " ^ (string_of_int n) ^ ")"
end

module Suit = struct
  type t = suit
  let ord = function
    | S n -> n

  let make n = S n

  let eq (a : t) (b : t) = (Pervasives.compare a b) == 0

  let str = function
    | S n -> "(suit " ^ (string_of_int n) ^ ")"
end

let int_flatten r s = (16 * r + s)

let int_unflatten v = (v / 16, v mod 16)

module Card = struct
  type t = card
  type kind = suit
  type compressed = compressed_card

  let eq (a : card) (b : card) = (Pervasives.compare a b) == 0

  let make count v : t = C (count, v)

  let fast a b : t = C (Rank.make a, Suit.make b)

  let kind_eq a b = Suit.eq a b
  let kind_of = function
    | C (_, x) -> Suit.ord x

  let rank = function
    | C (r, _) -> r

  let suit = function
    | C (_, s) -> s

  let unflatten = function
    | CC v ->
      let (f, s) = int_unflatten v in
      C (Rank.make f, Suit.make s)

  let flatten = function
    | C (r,s) -> CC (int_flatten (Rank.ord r) (Suit.ord s))

  let str = function
    | C (r,s) -> "(card " ^ (Rank.str r) ^ " " ^ (Suit.str s) ^ ")"
end

module CompressedCard = struct
  type t = compressed_card

  let eq (a : compressed_card) (b : compressed_card) = (Pervasives.compare a b) == 0
  let succ = function
    | CC v -> CC (v + 1)
end

module CompressedRankAndIndex = struct
  type t = compressed_rank_and_index

  let kind_of = function
    | CRI v -> v mod 16
end

module CountAndRank = struct
  type t = count_and_rank
  type kind = Rank.t
  type compressed = compressed_count_and_rank

  let make count v : t = CR (count, v)

  let rank = function
    | CR (_, x) -> x

  let count = function
    | CR (c, _) -> c

  let kind_eq a b = Rank.eq a b
  let kind_of : t -> kind = function
    | CR (_, x) -> x

  let unflatten = function
    | CCR v ->
      let (f, s) = int_unflatten v in
      CR (f, R s)

  let flatten = function
    | CR (c,r) -> CCR (int_flatten c (Rank.ord r))

  let str = function
    | CR (c,r) -> "(CR " ^ (string_of_int c) ^ " " ^ (Rank.str r) ^ ")"
end

module CountAndSuit = struct
  type t = count_and_suit
  type kind = Suit.t
  type compressed = compressed_count_and_suit

  let kind_eq (a : kind) (b : kind) = Suit.eq a b
  let kind_of = function
    | CS (_, x) -> x

  let make count v : t = CS (count, v)

  let unflatten = function
    | CCS v ->
      let (f, s) = int_unflatten v in
      CS (f, S s)

  let flatten = function
    | CS (c,s) -> CCS (int_flatten c (Suit.ord s))
end

module RankAndIndex = struct
  type t = rank_and_index
  type kind = int
  type compressed = compressed_rank_and_index

  let kind_eq (a : kind) (b : kind) = a == b
  let kind_of = function
    | RI (_, x) -> x

  let eq (a : t) (b : t) = (Pervasives.compare a b) == 0

  let make r i = RI (r, i)

  let unflatten = function
    | CRI v ->
      let (r, i) = int_unflatten v in
      RI (R r, i)

  let flatten = function
    | RI (r,i) -> CRI (int_flatten (Rank.ord r) i)
end

module type Printable = sig
  type t

  val str : t -> string
end

module PrintableList(P : Printable) = struct
  type t = P.t list

  let str (l : t) =
    "[" ^ (String.concat ", " (List.map P.str l)) ^ "]"
end

module PrintableOption(P : Printable) = struct
  type t = P.t option

  let str = function
    | None -> "None"
    | Some s -> "(Some " ^ (P.str s) ^ ")"
end

module PrintableCardList = PrintableList(Card)
module PrintableRankList = PrintableList(Rank)
module PrintableCountAndRankList = PrintableList(CountAndRank)
module PrintableSuitOption = PrintableOption(Suit)
module PrintableRankOption = PrintableOption(Rank)

module type Flattenable = sig
  type t
  type kind
  type compressed

  val kind_eq : kind -> kind -> bool
  val kind_of : t -> kind
  val make : int -> kind -> t
  val unflatten : compressed -> t
  val flatten : t -> compressed
end

module GroupByCount(F : Flattenable) = struct
  let rec inner (items : F.kind list) (last : F.kind) count : F.compressed list =
    match items with
    | [] -> [F.flatten (F.make count last)]
    | f_items :: r_items ->
      if F.kind_eq f_items last then
        inner r_items last (count + 1)
      else
        F.flatten (F.make count last) :: (inner r_items f_items 1)

  let clean (items : F.kind list) : F.t list =
    match items with
    | [] -> raise Unexpected
    | f_items :: _ ->
      let processed : F.compressed list = inner items f_items 0 in
      let result : F.t list = List.map F.unflatten processed in
      atomsort result
end

module RankGroupByCount = GroupByCount(CountAndRank)
module SuitGroupByCount = GroupByCount(CountAndSuit)

let rec find_straight_flush_indices_x (flush_suit : Suit.t) (straight_flush_high : Rank.t) (cards : Card.t list) : int =
  match cards with
  | [] -> 0
  | ((C (first_rank, first_suit)) :: remaining) ->
    let match_rank =
      (Rank.eq straight_flush_high (Rank.make 5)) &&
      (Rank.eq first_rank (Rank.make 14))
    in
    let rank_in_range =
      (Rank.ord first_rank) <= (Rank.ord straight_flush_high) &&
      ((Rank.ord first_rank) > ((Rank.ord straight_flush_high) - 5))
    in
    let hit = Suit.eq first_suit flush_suit && (match_rank || rank_in_range) in
    let new_bit = if hit then 1 else 0 in
    (2 * (find_straight_flush_indices flush_suit straight_flush_high remaining)) + new_bit
and find_straight_flush_indices flush_suit straight_flush_high cards =
  let res = find_straight_flush_indices_x flush_suit straight_flush_high cards in
  let _ = Printf.printf "find_straight_flush_indices %s %s %s => %d\n"
      (Suit.str flush_suit)
      (Rank.str straight_flush_high)
      (PrintableCardList.str cards)
      res
  in
  res

let rec flush_cards_with_index flush_suit index cards : compressed_rank_and_index list =
  match cards with
  | [] -> []
  | (C (first_rank, first_suit) :: remaining) ->
    if Suit.eq flush_suit first_suit then
      (RankAndIndex.flatten (RankAndIndex.make first_rank index)) :: (flush_cards_with_index flush_suit (index + 1) remaining)
    else
      flush_cards_with_index flush_suit (index + 1) remaining

module type BitFieldable = sig
  type t

  val eq : t -> t -> bool
  val succ : t -> t
end

let rec to_bitfield index includes =
  match includes with
  | [] -> 0
  | f_includes :: r_includes ->
    if index == f_includes then
      1 + (2 * (to_bitfield (index + 1) r_includes))
    else
      2 * (to_bitfield (index + 1) includes)

let rec find_straight_includes ranks with_index =
  match ranks with
  | [] -> raise Unexpected
  | f_ranks :: r_ranks ->
    match with_index with
    | [] -> raise Unexpected
    | f_with_index :: r_with_index ->
    if f_ranks == f_with_index / 16 then
      (f_with_index mod 16) :: (find_straight_includes r_ranks r_with_index)
    else
      find_straight_includes ranks r_with_index

let rec ranks_with_indices index = function
  | [] -> []
  | (C (r,s)) :: r_cards ->
    (int_flatten (Rank.ord r) index) :: (ranks_with_indices (index + 1) r_cards)

let find_straight_indices my_straight_high cards =
  let with_index = atomsort (ranks_with_indices 0 cards) in
  let my_ranks = if my_straight_high == 5 then
      [14 ; 5 ; 4 ; 3 ; 2]
    else
      [ my_straight_high ; my_straight_high - 1 ; my_straight_high - 2 ; my_straight_high - 3 ; my_straight_high - 4 ]
  in
  let includes = List.rev (atomsort (find_straight_includes my_ranks with_index)) in
  to_bitfield 0 includes

let ranks_with_indices index = function
  | [] -> []
  | (C (r,s)) :: r_cards ->
    (int_flatten (Rank.ord r) index) :: (ranks_with_indices (index + 1) r_cards)

let find_hand_indices cards =
  let flattened_cards = atomsort (ranks_with_indices 0 cards) in
  let indices = List.rev (atomsort (List.map (fun x -> x mod 16) flattened_cards)) in
  to_bitfield 0 indices

let find_flush (suits : Suit.t list) : Suit.t option =
  match SuitGroupByCount.clean (atomsort suits) with
  | [] -> raise Unexpected
  | CS (count1, suit1) :: _ ->
    if count1 >= 5 then
      Some suit1
    else
      None

let rec straight_high_inner ranks last count : Rank.t option =
  match ranks with
  | [] ->
    if Rank.eq last (Rank.make 2) && count == 4 then
      Some (Rank.make 5)
    else
      None
  | f_ranks :: r_ranks ->
    if Rank.eq last f_ranks then
      straight_high_inner r_ranks last count
    else
      if Rank.eq f_ranks (Rank.pred last) then
        if count == 4 then
          (* found a straight, add 3 to last because next and last are included *)
          Some (Rank.add 3 last)
        else
          straight_high_inner r_ranks f_ranks (count + 1)
      else
        straight_high_inner r_ranks f_ranks 1

let straight_high_extended ranks : Rank.t option =
  let high = straight_high_inner ranks Rank.zero 0 in
  match high with
  | Some high ->
    if Rank.eq high (Rank.make 5) then
      match ranks with
      | [] -> raise Unexpected
      | f_ranks :: _ ->
        if Rank.eq f_ranks (Rank.make 14) then
          Some (Rank.make 5)
        else
          None
    else
      Some high
  | _ -> None

let find_flush_indices flush_suit cards =
  let myfiltered = truncate 5 (atomsort (flush_cards_with_index flush_suit 0 cards)) in
  to_bitfield 0 (List.rev (atomsort (List.map CompressedRankAndIndex.kind_of myfiltered)))

let rec member_of_hand rank : (CountAndRank.t list -> bool) = function
  | [] -> false
  | f_hand :: r_hand ->
    if Rank.eq (CountAndRank.kind_of f_hand) rank then
      true
    else
      member_of_hand rank r_hand

let rec remove_rank_from_hand rank = function
  | [] -> []
  | f_hand :: r_hand ->
    if CountAndRank.rank f_hand == rank then
      if CountAndRank.count f_hand > 0 then
        r_hand
      else
        (CountAndRank.make ((CountAndRank.count f_hand) - 1) (CountAndRank.rank f_hand)) :: r_hand
    else
      f_hand :: (remove_rank_from_hand rank r_hand)

let rec ranks_from_hand hand = function
  | [] -> []
  | (C (first_rank, first_suit) :: remaining_cards) ->
    if member_of_hand first_rank hand then
      let new_hand = remove_rank_from_hand first_rank hand in
      (C (first_rank, first_suit)) :: (ranks_from_hand new_hand remaining_cards)
    else
      ranks_from_hand hand remaining_cards

let rec bitmap_from_members chosen = function
  | [] -> 0
  | hd :: tl ->
    let new_bit =
      if List.mem hd chosen then
        1
      else
        0
    in
    new_bit + (2 * (bitmap_from_members chosen tl))

let rec find_hand_indices hand cards =
  let chosen_cards = ranks_from_hand hand cards in
  bitmap_from_members chosen_cards cards

let handcalc (cards : Card.t list) =
  let sorted_ranks = atomsort (List.map Card.rank cards) in
  let _ =
    Printf.printf "sorted_ranks %s\n" (PrintableRankList.str sorted_ranks)
  in
  let hand = RankGroupByCount.clean sorted_ranks in
  let _ =
    Printf.printf "hand %s\n" (PrintableCountAndRankList.str hand)
  in
  let (CR (firstcount, firstrank), CR (secondcount, secondrank)) =
    match hand with
    | a :: b :: _ -> (a, b)
    | _ -> raise Unexpected
  in
  let _ =
    Printf.printf "first of hand %s %s\n"
      (CountAndRank.str (CR (firstcount, firstrank)))
      (CountAndRank.str (CR (secondcount, secondrank)))
  in
  let flush_suit = find_flush (List.map Card.suit cards) in
  let _ =
    Printf.printf "flush suit %s\n" (PrintableSuitOption.str flush_suit)
  in
  match flush_suit with
  | Some flush_suit ->
    begin
      let flush_cards = List.flatten (List.map (fun thecard -> if (Suit.eq (Card.suit thecard) flush_suit) then [Card.rank thecard] else []) cards) in
      let _ =
        Printf.printf "flush_cards %s\n"
          (PrintableRankList.str flush_cards)
      in
      let straight_flush_high = straight_high_extended (atomsort flush_cards) in
      let _ =
        Printf.printf "straight_flush_high %s\n"
          (PrintableRankOption.str straight_flush_high)
      in
      match straight_flush_high with
      | Some straight_flush_high ->
        find_straight_flush_indices flush_suit straight_flush_high cards
      | _ ->
        if (firstcount > 3) || ((firstcount == 3) && (secondcount == 1)) then
          find_flush_indices flush_suit cards
        else
          find_hand_indices hand cards
    end
  | None ->
    begin
      let my_straight_high = straight_high_extended sorted_ranks in
      match my_straight_high with
      | Some my_straight_high ->
        find_straight_indices (Rank.ord my_straight_high) cards
      | _ -> find_hand_indices hand cards
    end
