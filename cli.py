"""Command-line interface for the fashion design reference library.

Usage:
    python cli.py add path/to/image.jpg --title "Balenciaga 1967" --source "V&A archive"
    python cli.py list
    python cli.py show <id>
    python cli.py search "sculptural silhouettes 1960s"
    python cli.py analyze <id1> <id2> ...
"""
import argparse
from pathlib import Path

import analyze
import colour
import db
import embeddings
import ingest


def cmd_add(args):
    print(f"Adding {args.path} ...")
    try:
        result = ingest.add_reference(
            args.path,
            title=args.title,
            source=args.source,
            notes=args.notes,
            force=args.force,
            is_own_work=args.own_work,
        )
    except ingest.DuplicateReferenceError as e:
        print(f"\nSkipped: {e}")
        print("Use --force to add it anyway.")
        return
    print(f"\nAdded reference {result['id']}")
    print(f"  Title: {result['title']}")
    print(f"  Type: {result['type']}")
    print(f"  Tags: {', '.join(result['tags'])}")
    print(f"  Description: {result['description']}")


def cmd_add_folder(args):
    print(f"Scanning {args.folder} ...")
    results, skipped, errors = ingest.add_folder(
        args.folder,
        source=args.source,
        notes=args.notes,
        recursive=args.recursive,
        force=args.force,
        is_own_work=args.own_work,
    )
    print(f"\nDone. Added {len(results)} reference(s).")
    if skipped:
        print(f"{len(skipped)} file(s) skipped as duplicates already in the library:")
        for path, _ in skipped:
            print(f"  {path.name}")
    if errors:
        print(f"{len(errors)} file(s) failed:")
        for path, err in errors:
            print(f"  {path.name}: {err}")


def cmd_list(args):
    refs = db.list_references()
    if not refs:
        print("No references yet. Add one with: python cli.py add <path>")
        return
    for r in refs:
        print(f"[{r['type']:5}] {r['id'][:8]}  {r['title']}")
        if r["tags"]:
            print(f"          tags: {', '.join(r['tags'])}")


def cmd_show(args):
    ref = db.get_reference(args.id)
    if not ref:
        matches = db.find_by_id_prefix(args.id)
        if len(matches) == 1:
            ref = matches[0]
        elif len(matches) > 1:
            print(f"'{args.id}' matches multiple references, be more specific:")
            for m in matches:
                print(f"  {m['id']}  {m['title']}")
            return
    if not ref:
        print("Reference not found.")
        return
    for key, value in ref.items():
        print(f"{key}: {value}")


def cmd_search(args):
    model = embeddings.get_model()
    query_embedding = model.encode(args.query).tolist()
    matches = embeddings.query_index(query_embedding, n_results=args.n)
    if not matches:
        print("No results. Add some references first.")
        return
    print(f'Results for "{args.query}":\n')
    for m in matches:
        meta = m["metadata"]
        label = embeddings.match_label(m["relative_score"])
        print(f"[{meta['type']:5}] {meta['title']}  ({label})")
        if meta.get("tags"):
            print(f"          tags: {meta['tags']}")


def cmd_analyze(args):
    print(f"Analyzing {len(args.ids)} reference(s) ...")
    try:
        writeup, messages, _ = analyze.start_conversation(args.ids)
    except ValueError as e:
        print(f"Error: {e}")
        return
    print()
    print(writeup)

    transcript = [writeup]
    print("\nAsk a follow-up to explore further, or press enter to quit.")
    while True:
        try:
            user_input = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not user_input:
            break
        reply = analyze.continue_conversation(messages, user_input)
        print(f"\n{reply}")
        transcript.append(f"> {user_input}\n\n{reply}")

    if args.save:
        Path(args.save).write_text("\n\n---\n\n".join(transcript), encoding="utf-8")
        print(f"\nSaved to {args.save}")


def cmd_colour_backfill(args):
    """Generate colour analyses for images that don't have a current one.

    Safe to re-run: anything already analysed at the current version, with an
    unchanged file, is skipped -- so this is cheap when there's nothing to do.
    """
    before = colour.coverage()
    if before["pending"] == 0 and not args.limit:
        print(f"All {before['images']} image references already analysed (v{before['version']}).")
        return

    print(f"{before['pending']} of {before['images']} image reference(s) need colour analysis.")

    def progress(done, total, _ref_id):
        end = "\n" if done == total else "\r"
        print(f"  analysing {done}/{total} ...", end=end, flush=True)

    analysed, failed = colour.backfill(limit=args.limit, progress=progress)
    after = colour.coverage()
    print(f"Analysed {analysed}, failed {failed}. Coverage: {after['analysed']}/{after['images']}.")


def main():
    parser = argparse.ArgumentParser(description="Fashion design reference library")
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="Add a new reference (image, text, or PDF)")
    p_add.add_argument("path", help="Path to the file to add")
    p_add.add_argument("--title", help="Title for the reference")
    p_add.add_argument("--source", help="Where this came from (book, url, designer, etc.)")
    p_add.add_argument("--notes", help="Your own notes about it")
    p_add.add_argument("--force", action="store_true", help="Add even if an identical file already exists")
    p_add.add_argument("--own-work", dest="own_work", action="store_true", help="Mark this as your own work")
    p_add.set_defaults(func=cmd_add)

    p_add_folder = sub.add_parser("add-folder", help="Add every supported file in a folder")
    p_add_folder.add_argument("folder", help="Path to a folder of references")
    p_add_folder.add_argument("--source", help="Applied to every reference added")
    p_add_folder.add_argument("--notes", help="Applied to every reference added")
    p_add_folder.add_argument("--recursive", action="store_true", help="Include subfolders")
    p_add_folder.add_argument("--force", action="store_true", help="Add even if identical files already exist")
    p_add_folder.add_argument(
        "--own-work", dest="own_work", action="store_true", help="Mark every reference added as your own work"
    )
    p_add_folder.set_defaults(func=cmd_add_folder)

    p_list = sub.add_parser("list", help="List all references")
    p_list.set_defaults(func=cmd_list)

    p_show = sub.add_parser("show", help="Show full details for a reference")
    p_show.add_argument("id", help="Reference id (or a unique short prefix of it)")
    p_show.set_defaults(func=cmd_show)

    p_search = sub.add_parser("search", help="Semantic search across all references")
    p_search.add_argument("query", help="Search query (natural language)")
    p_search.add_argument("-n", type=int, default=5, help="Number of results (default 5)")
    p_search.set_defaults(func=cmd_search)

    p_analyze = sub.add_parser(
        "analyze", help="Analyze a handful of references: find connections and suggest research directions"
    )
    p_analyze.add_argument("ids", nargs="+", help="Reference ids (or unique short prefixes) to analyze")
    p_analyze.add_argument("--save", help="Also save the full conversation transcript to a file")
    p_analyze.set_defaults(func=cmd_analyze)

    p_colour = sub.add_parser(
        "colour-backfill",
        help="Generate colour analysis for image references that don't have it yet",
    )
    p_colour.add_argument(
        "--limit", type=int, help="Only analyse this many (useful for a large archive)"
    )
    p_colour.set_defaults(func=cmd_colour_backfill)

    args = parser.parse_args()
    db.init_db()
    args.func(args)


if __name__ == "__main__":
    main()
