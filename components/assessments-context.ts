"use client";

import { createContext } from "react";
import type { PracticeAssessment } from "@/src/core";

/**
 * The answer check (M24): the open practice session's independent grades,
 * keyed by conclude call id. Chat adopts the record's assessments log on
 * every record sync (the check lands after the turn settles and announces
 * itself with record-changed); each conclude card reads its own entry.
 * Empty outside a session, so a card rendered elsewhere shows no check.
 */
export const AssessmentsContext = createContext<Readonly<Record<string, PracticeAssessment>>>({});
