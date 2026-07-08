import { moment as _moment } from "obsidian";
import type { Moment, MomentInput, MomentFormatSpecification } from "moment";

type MomentFactory = (
  input?: MomentInput,
  format?: MomentFormatSpecification,
  strict?: boolean,
) => Moment;

export const moment = _moment as unknown as MomentFactory;
export type { Moment };
