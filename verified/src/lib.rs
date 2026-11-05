//! Cairn's review rating, proved with Verus.
//!
//! The rule `reviewRating` in src/core/review-schedule.ts follows. Each
//! `ensures` clause on `review_rating` states one requirement from
//! verified/README.md (R1 to R7), tagged C1 to C7 so the mutation check in
//! verified/check.mjs can tell which requirement caught a planted bug.
//! Everything inside `verus!` is checked. The `extern "C"` shim at the
//! bottom is outside it and is trusted (TB1 in the README): it only turns
//! integer codes into the enums and back, and the differential test checks it.

use vstd::prelude::*;

verus! {

/// How the tutor concluded the problem. `Unknown` is anything else: a
/// dismissed problem, or an outcome this build doesn't know.
pub enum Outcome {
    Solved,
    SolvedWithHints,
    MovedOn,
    Surrendered,
    Unknown,
}

/// The deepest hint the learner needed. `Unknown` is no rung, or one this
/// build doesn't know.
pub enum Rung {
    R0,
    R1,
    R2,
    R3,
    R4,
    R5,
    Unknown,
}

pub enum Judgment {
    Correct,
    Partial,
    Incorrect,
    Unanswered,
}

/// The answer check (M24), when it ran.
pub enum Check {
    Absent,
    Ran { agrees: bool, judgment: Judgment },
}

pub enum Rating {
    Again,
    Hard,
    Good,
}

// ─── The requirements' vocabulary (spec only, erased from the build) ─────

pub open spec fn rank(r: Rating) -> int {
    match r {
        Rating::Again => 0,
        Rating::Hard => 1,
        Rating::Good => 2,
    }
}

pub open spec fn lower(a: Rating, b: Rating) -> Rating {
    if rank(a) <= rank(b) { a } else { b }
}

pub open spec fn at_least_hard(r: Rating) -> Rating {
    if rank(r) < rank(Rating::Hard) { Rating::Hard } else { r }
}

/// The tutor gave credit: the learner reached the answer.
pub open spec fn credited(o: Outcome) -> bool {
    o is Solved || o is SolvedWithHints
}

/// The hint ladder (practice doctrine §VI): R0-R1 about right, R2 narrowed
/// the candidates, R3 on gave the retrieval away.
pub open spec fn ladder(rung: Rung, hinted: bool) -> Rating {
    match rung {
        Rung::R0 | Rung::R1 => Rating::Good,
        Rung::R2 => Rating::Hard,
        Rung::R3 | Rung::R4 | Rung::R5 => Rating::Again,
        Rung::Unknown => if hinted { Rating::Hard } else { Rating::Good },
    }
}

/// What the tutor's own record earns, before the answer check has a say.
pub open spec fn tutor_rating(o: Outcome, rung: Rung, careless: bool) -> Rating {
    let base = if credited(o) { ladder(rung, o is SolvedWithHints) } else { Rating::Again };
    if careless { at_least_hard(base) } else { base }
}

pub open spec fn disagrees(c: Check) -> bool {
    match c {
        Check::Ran { agrees, .. } => !agrees,
        Check::Absent => false,
    }
}

pub open spec fn judged_partial(c: Check) -> bool {
    match c {
        Check::Ran { judgment, .. } => judgment is Partial,
        Check::Absent => false,
    }
}

// ─── The code ────────────────────────────────────────────────────────────

fn rank_of(r: &Rating) -> (n: u8)
    ensures
        n as int == rank(*r),
{
    match r {
        Rating::Again => 0,
        Rating::Hard => 1,
        Rating::Good => 2,
    }
}

/// One retrieval's rating, or None when the retrieval doesn't count.
pub fn review_rating(outcome: Outcome, rung: Rung, careless: bool, check: Check) -> (r: Option<Rating>)
    ensures
        // R1. A dismissed problem, or an outcome this build doesn't know, doesn't count; every other one does.
        (r is None) <==> (outcome is Unknown), // C1
        // R2. Unless the check disputes a credited outcome, the rating is the tutor's: the hint ladder, Again for a miss, the careless floor.
        !(outcome is Unknown) && !(credited(outcome) && disagrees(check)) ==> r == Some(tutor_rating(outcome, rung, careless)), // C2
        // R3. The check never raises a rating.
        r matches Some(x) ==> rank(x) <= rank(tutor_rating(outcome, rung, careless)), // C3
        // R4. The check disputes a credited outcome and judges the answer partial: the rating drops to Hard, or stays lower.
        credited(outcome) && disagrees(check) && judged_partial(check) && !careless ==> r == Some(lower(ladder(rung, outcome is SolvedWithHints), Rating::Hard)), // C4
        // R5. The check disputes a credited outcome and judges the answer wrong or missing: the rating drops to Again.
        credited(outcome) && disagrees(check) && !judged_partial(check) && !careless ==> r == Some(Rating::Again), // C5
        // R6. A careless miss is a slip, not a gap: never worse than Hard.
        r matches Some(x) ==> (careless ==> rank(x) >= rank(Rating::Hard)), // C6
        // R7. The careless floor applies last: a careless miss the check disputes is exactly Hard.
        credited(outcome) && disagrees(check) && careless ==> r == Some(Rating::Hard), // C7
{
    let mut rating = match outcome {
        Outcome::Solved | Outcome::SolvedWithHints => {
            let hinted = match outcome {
                Outcome::SolvedWithHints => true,
                _ => false,
            };
            let mut rating = match rung {
                Rung::R0 | Rung::R1 => Rating::Good,
                Rung::R2 => Rating::Hard,
                Rung::R3 | Rung::R4 | Rung::R5 => Rating::Again,
                Rung::Unknown => if hinted { Rating::Hard } else { Rating::Good },
            };
            match check {
                Check::Ran { agrees, judgment } => {
                    if !agrees {
                        let floor = match judgment { Judgment::Partial => Rating::Hard, _ => Rating::Again };
                        if rank_of(&floor) < rank_of(&rating) {
                            rating = floor;
                        }
                    }
                },
                Check::Absent => {},
            }
            rating
        },
        Outcome::MovedOn | Outcome::Surrendered => Rating::Again,
        Outcome::Unknown => {
            return None;
        },
    };
    if careless && rank_of(&rating) < rank_of(&Rating::Hard) {
        rating = Rating::Hard;
    }
    Some(rating)
}

} // verus!

// ─── The trusted shim (TB1 in the README, not verified): the WASM export ─

/// Codes: outcome 0 solved, 1 solvedWithHints, 2 movedOn, 3 surrendered,
/// anything else unknown. Rung 0-5 is R0-R5, anything else unknown.
/// Careless 0 or 1. Check 0 absent, 1 agrees, 2 disagrees, anything else
/// absent. Judgment 0 correct, 1 partial, 2 incorrect, 3 unanswered,
/// anything else incorrect. Result 0 none, 1 Again, 2 Hard, 3 Good.
#[no_mangle]
pub extern "C" fn review_rating_code(outcome: u32, rung: u32, careless: u32, check: u32, judgment: u32) -> u32 {
    let outcome = match outcome {
        0 => Outcome::Solved,
        1 => Outcome::SolvedWithHints,
        2 => Outcome::MovedOn,
        3 => Outcome::Surrendered,
        _ => Outcome::Unknown,
    };
    let rung = match rung {
        0 => Rung::R0,
        1 => Rung::R1,
        2 => Rung::R2,
        3 => Rung::R3,
        4 => Rung::R4,
        5 => Rung::R5,
        _ => Rung::Unknown,
    };
    let judgment = match judgment {
        0 => Judgment::Correct,
        1 => Judgment::Partial,
        3 => Judgment::Unanswered,
        _ => Judgment::Incorrect,
    };
    let check = match check {
        1 => Check::Ran { agrees: true, judgment },
        2 => Check::Ran { agrees: false, judgment },
        _ => Check::Absent,
    };
    match review_rating(outcome, rung, careless != 0, check) {
        None => 0,
        Some(Rating::Again) => 1,
        Some(Rating::Hard) => 2,
        Some(Rating::Good) => 3,
    }
}
