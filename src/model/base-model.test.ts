import { describe, it, expect, vi } from "vitest";
import { BaseModel, NoteReading, type ModelCache, type ModelIO } from "./base-model";
import type { IModel, NoteModel } from "./i-model";

interface Fields {
  title: string;
  count?: number;
}

/** The file under a model, standing in for a `BaseIO`: what it was told, and by whom. */
function io(filePath = "note.md") {
  const attached: NoteModel<Fields>[] = [];
  const detached: IModel[] = [];
  const flushed: string[] = [];
  const file: ModelIO<Fields> = {
    filePath,
    attachNote: (model) => { attached.push(model); },
    detach: (model) => { detached.push(model); },
    flush: () => { flushed.push(filePath); return Promise.resolve(); },
  };
  return Object.assign(file, { attached, detached, flushed });
}

function cache(): ModelCache & { told: IModel[] } {
  const told: IModel[] = [];
  return { told, changed: (model) => { told.push(model); } };
}

class Note extends BaseModel<ModelIO<Fields>, Fields> {
  get id(): string {
    return this.state.title;
  }

  /** The two members a subclass reads through, opened up so a test can see them. */
  get fields(): Fields {
    return this.state;
  }

  set(field: keyof Fields, value: Fields[keyof Fields]): boolean {
    return this.put(field, value);
  }
}

describe("NoteReading", () => {
  /** A reading of a model that is not a `BaseModel`, which is the case it exists for. */
  function reading(fields: Fields = { title: "One" }) {
    const persistence = io();
    const told = cache();
    const of = {
      id: "m1", filePath: "note.md", refresh: vi.fn(), discard: vi.fn(), take: vi.fn(),
    };
    return { persistence, told, of, note: new NoteReading(persistence, told, fields, of) };
  }

  it("attaches the model it is of to the file, not itself", () => {
    const { persistence, of } = reading();

    expect(persistence.attached).toEqual([of]);
  });

  it("keeps what the file last said", () => {
    const { note } = reading();

    note.take({ title: "Two" });

    expect(note.fields).toEqual({ title: "Two" });
  });

  it("wakes the model when the reading moved", () => {
    const { note, of } = reading();

    expect(note.take({ title: "Two" })).toBe(true);
    expect(of.refresh).toHaveBeenCalledOnce();
  });

  it("says nothing when the reading landed what it already held", () => {
    const { note, of } = reading();

    expect(note.take({ title: "One" })).toBe(false);
    expect(of.refresh).not.toHaveBeenCalled();
  });

  it("keeps a move to itself when asked not to tell", () => {
    const { note, of } = reading();

    expect(note.take({ title: "Two" }, false)).toBe(true);
    expect(of.refresh).not.toHaveBeenCalled();
  });

  it("takes one field on without telling anyone", () => {
    const { note, told, of } = reading();

    expect(note.put("title", "Two")).toBe(true);
    expect(note.fields).toEqual({ title: "Two" });
    expect(told.told).toEqual([]);
    expect(of.refresh).not.toHaveBeenCalled();
  });

  it("leaves the reading alone when the field already reads that way", () => {
    const { note } = reading();

    expect(note.put("title", "One")).toBe(false);
  });

  it("reads its path off the file", () => {
    const { note } = reading();

    expect(note.filePath).toBe("note.md");
  });

  it("flushes through the file", async () => {
    const { note, persistence } = reading();

    await note.flush();

    expect(persistence.flushed).toEqual(["note.md"]);
  });

  it("tells the cache about the model it is of when it refreshes", () => {
    const { note, told, of } = reading();

    note.refresh();

    expect(told.told).toEqual([of]);
  });

  it("detaches from the file and tells the cache when the note is gone", () => {
    const { note, persistence, told, of } = reading();

    note.discard();

    expect(note.isGone).toBe(true);
    expect(persistence.detached).toEqual([of]);
    expect(told.told).toEqual([of]);
  });

  it("goes only once, however often it is discarded", () => {
    const { note, persistence, told } = reading();

    note.discard();
    note.discard();

    expect(persistence.detached).toHaveLength(1);
    expect(told.told).toHaveLength(1);
  });
});

describe("BaseModel", () => {
  function model(fields: Fields = { title: "One" }) {
    const persistence = io();
    const told = cache();
    return { persistence, told, note: new Note(persistence, told, fields) };
  }

  it("attaches itself to its file as it is made", () => {
    const { persistence, note } = model();

    expect(persistence.attached).toEqual([note]);
  });

  it("reads its own fields off what the file last said", () => {
    const { note } = model();

    note.take({ title: "Two", count: 3 });

    expect(note.fields).toEqual({ title: "Two", count: 3 });
    expect(note.id).toBe("Two");
  });

  it("answers whether a reading moved anything, and tells the cache when it did", () => {
    const { note, told } = model();

    expect(note.take({ title: "One" })).toBe(false);
    expect(note.take({ title: "Two" })).toBe(true);
    expect(told.told).toEqual([note]);
  });

  it("keeps a move to itself when asked not to tell", () => {
    const { note, told } = model();

    expect(note.take({ title: "Two" }, false)).toBe(true);
    expect(told.told).toEqual([]);
  });

  it("takes one field on ahead of the next read", () => {
    const { note, told } = model();

    expect(note.set("title", "Two")).toBe(true);
    expect(note.set("title", "Two")).toBe(false);
    expect(note.fields.title).toBe("Two");
    expect(told.told).toEqual([]);
  });

  it("hands out the file it was made over", () => {
    const { note, persistence } = model();

    expect(note.persistence).toBe(persistence);
    expect(note.filePath).toBe("note.md");
  });

  it("flushes through its file", async () => {
    const { note, persistence } = model();

    await note.flush();

    expect(persistence.flushed).toEqual(["note.md"]);
  });

  it("holds what it last said once its note is gone", () => {
    const { note, persistence, told } = model();

    note.discard();

    expect(note.isGone).toBe(true);
    expect(note.fields).toEqual({ title: "One" });
    expect(persistence.detached).toEqual([note]);
    expect(told.told).toEqual([note]);
  });
});
