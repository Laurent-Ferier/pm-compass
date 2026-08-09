import { moment as _moment } from "obsidian";
import type { Moment, MomentInput, MomentFormatSpecification, Locale } from "moment";

type MomentFactory = ((
  input?: MomentInput,
  format?: MomentFormatSpecification,
  strict?: boolean,
) => Moment) & {
  localeData(): Locale;
  weekdaysMin(localeSorted?: boolean): string[];
  weekdaysShort(localeSorted?: boolean): string[];
};

export const moment = _moment as unknown as MomentFactory;
export type { Moment };
