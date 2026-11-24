"use client";

import {
  ArrowLeft,
  ChevronUp,
  Eye,
  Flag,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { BrandMark } from "@/components/brand-mark";
import { fetchSharedProjects } from "@/components/room-capture/shared-projects-api";
import studio from "@/components/room-capture/room-capture.module.css";
import { PanoramaCanvas } from "@/components/tour/panorama-canvas";
import {
  clampFov,
  clampPitch,
  projectSphericalPoint,
  shortestAngleDelta,
  wrapDegrees,
  type PanoramaView,
} from "@/components/tour/tour-math";
import {
  arrivalYaw,
  findSpot,
  linkAhead,
  newTourItemId,
  placeLink,
  removeLink,
  removeSpot,
  unprojectViewportPoint,
  unreachableSpots,
} from "@/lib/house-tour";
import type { SharedRoomProject } from "@/types/capture";
import type { HouseTour, HouseTourInput, HouseTourSpot } from "@/types/house-tour";

import { deleteTour, fetchTour, panoramaUrl, saveTour } from "./house-tour-api";
import styles from "./house-tour.module.css";

const DEFAULT_FOV = 75;
const DRAG_THRESHOLD_PX = 5;
const FADE_MS = 220;
const TURN_STEP = 10;

type Notice = { text: string; goToSpotId?: string } | null;

function toInput(tour: HouseTour): HouseTourInput {
  return { name: tour.name, startSpotId: tour.startSpotId, spots: tour.spots };
}

/** Size of an element that may mount later (the stage appears once the tour loads). */
function useElementSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    if (typeof ResizeObserver === "undefined") {
      const first = window.setTimeout(update, 0);
      window.addEventListener("resize", update);
      return () => {
        window.clearTimeout(first);
        window.removeEventListener("resize", update);
      };
    }
    // ResizeObserver also reports the initial size as soon as it observes.
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/**
 * A house tour in the style of Street View / GeoGuessr: one 360° room at a
 * time, drag to look around, click an arrow (or press W / ↑) to walk to the
 * next spot.  With `edit`, the owner places those arrows by clicking where
 * each doorway is.
 */
export function HouseTourViewer({ tourId, initialEdit = false }: { tourId: string; initialEdit?: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; yaw: number; pitch: number; moved: boolean } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; fov: number } | null>(null);
  const fadeTimerRef = useRef<number | null>(null);

  const [tour, setTour] = useState<HouseTour | null>(null);
  const [draft, setDraft] = useState<HouseTourInput | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [spotId, setSpotId] = useState<string | null>(null);
  const [view, setView] = useState<PanoramaView>({ yaw: 0, pitch: 0, fov: DEFAULT_FOV });
  const [editing, setEditing] = useState(initialEdit);
  const [placingTarget, setPlacingTarget] = useState<string | null>(null);
  const [arrowTarget, setArrowTarget] = useState("");
  const [fading, setFading] = useState(false);
  const [failedSpots, setFailedSpots] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<SharedRoomProject[] | null>(null);
  const [roomsToAdd, setRoomsToAdd] = useState<Set<string>>(() => new Set());
  const size = useElementSize(stage);

  useEffect(() => {
    const controller = new AbortController();
    fetchTour(tourId, controller.signal)
      .then((loaded) => {
        if (!loaded) {
          setNotFound(true);
          return;
        }
        setTour(loaded);
        setDraft(toInput(loaded));
        const start = findSpot(loaded, loaded.startSpotId) ?? loaded.spots[0];
        setSpotId(start.id);
        setView({ yaw: start.startYaw, pitch: 0, fov: DEFAULT_FOV });
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") setLoadError(error.message);
      });
    return () => controller.abort();
  }, [tourId]);

  useEffect(() => {
    if (!editing || rooms) return;
    fetchSharedProjects().then(setRooms).catch(() => setRooms([]));
  }, [editing, rooms]);

  useEffect(() => () => {
    if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current);
  }, []);

  // Leaving with unsaved arrows asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const spot = draft && spotId ? findSpot(draft, spotId) : null;
  const spotName = useCallback((id: string) => (draft ? findSpot(draft, id)?.name : null) ?? "another room", [draft]);

  const update = (next: HouseTourInput) => {
    setDraft(next);
    setDirty(true);
    setSaving("idle");
  };

  const updateSpot = (id: string, change: Partial<HouseTourSpot>) => {
    if (!draft) return;
    update({ ...draft, spots: draft.spots.map((item) => item.id === id ? { ...item, ...change } : item) });
  };

  const goTo = useCallback((targetId: string, options: { instant?: boolean } = {}) => {
    if (!draft || !spotId || targetId === spotId) return;
    const from = spotId;
    const arrive = () => {
      setSpotId(targetId);
      setView((current) => ({ yaw: arrivalYaw(draft, from, targetId), pitch: 0, fov: current.fov }));
      setPlacingTarget(null);
    };
    if (options.instant) {
      arrive();
      return;
    }
    setFading(true);
    if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = window.setTimeout(() => {
      arrive();
      fadeTimerRef.current = window.setTimeout(() => setFading(false), FADE_MS);
    }, FADE_MS);
  }, [draft, spotId]);

  const look = (yawDelta: number, pitchDelta = 0) => {
    setView((current) => ({ ...current, yaw: wrapDegrees(current.yaw + yawDelta), pitch: clampPitch(current.pitch + pitchDelta) }));
  };

  // ------------------------------------------------------------ pointer input

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), fov: view.fov };
      dragRef.current = null;
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch, moved: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance > 0) setView((current) => ({ ...current, fov: clampFov(pinch.fov * (pinch.distance / distance)) }));
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    // Grab-and-drag: the room follows the finger.
    const degreesPerPixel = view.fov / Math.max(1, size.height);
    setView((current) => ({
      ...current,
      yaw: wrapDegrees(drag.yaw - dx * degreesPerPixel),
      pitch: clampPitch(drag.pitch + dy * degreesPerPixel),
    }));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.id !== event.pointerId || drag.moved || !placingTarget || !draft || !spotId) return;
    // A click (not a drag) while placing drops the arrow under the pointer.
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = unprojectViewportPoint(event.clientX - bounds.left, event.clientY - bounds.top, view, bounds.width, bounds.height);
    const next = placeLink(draft, spotId, placingTarget, point);
    update(next);
    const target = findSpot(next, placingTarget);
    setPlacingTarget(null);
    setArrowTarget("");
    if (target && !target.links.some((link) => link.targetSpotId === spotId)) {
      setNotice({ text: `Arrow to ${target.name} placed. Now go there and place the arrow back to ${spot?.name ?? "this room"}.`, goToSpotId: target.id });
    } else {
      setNotice({ text: `Arrow to ${target?.name ?? "the room"} placed.` });
    }
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    setView((current) => ({ ...current, fov: clampFov(current.fov + event.deltaY * 0.04) }));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!spot) return;
    const key = event.key.toLowerCase();
    if (key === "arrowleft" || key === "a") look(-TURN_STEP);
    else if (key === "arrowright" || key === "d") look(TURN_STEP);
    else if (key === "arrowdown" || key === "s") look(180);
    else if (key === "arrowup" || key === "w") {
      const ahead = linkAhead(spot, view.yaw);
      if (ahead) goTo(ahead.targetSpotId);
    } else if (key === "+" || key === "=") setView((current) => ({ ...current, fov: clampFov(current.fov - 8) }));
    else if (key === "-") setView((current) => ({ ...current, fov: clampFov(current.fov + 8) }));
    else if (key === "escape" && placingTarget) setPlacingTarget(null);
    else return;
    event.preventDefault();
  };

  // ------------------------------------------------------------ saving

  const save = async () => {
    if (!draft || !tour) return;
    setSaving("saving");
    setSaveError(null);
    try {
      const saved = await saveTour(tour.id, draft);
      setTour(saved);
      setDraft(toInput(saved));
      if (spotId && !findSpot(saved, spotId)) setSpotId(saved.startSpotId);
      setDirty(false);
      setSaving("saved");
    } catch (error) {
      setSaving("error");
      setSaveError(error instanceof Error ? error.message : "The tour could not be saved.");
    }
  };

  const remove = async () => {
    if (!tour || !window.confirm(`Delete the tour “${tour.name}”? The 360° rooms stay in the studio.`)) return;
    try {
      await deleteTour(tour.id);
      setDirty(false);
      router.push("/tours");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The tour could not be deleted.");
    }
  };

  const addRooms = () => {
    if (!draft || !rooms) return;
    const added: HouseTourSpot[] = rooms
      .filter((room) => roomsToAdd.has(room.id))
      .map((room) => ({ id: newTourItemId(), projectId: room.id, name: room.name, startYaw: 0, links: [] }));
    if (added.length === 0) return;
    update({ ...draft, spots: [...draft.spots, ...added] });
    setRoomsToAdd(new Set());
  };

  const removeRoom = (id: string) => {
    if (!draft || draft.spots.length <= 1) return;
    const target = findSpot(draft, id);
    if (!window.confirm(`Remove “${target?.name}” and its arrows from the tour?`)) return;
    const next = removeSpot(draft, id);
    update(next);
    if (spotId === id) {
      const start = findSpot(next, next.startSpotId) ?? next.spots[0];
      setSpotId(start.id);
      setView((current) => ({ ...current, yaw: start.startYaw, pitch: 0 }));
    }
  };

  // ------------------------------------------------------------ render

  const projected = useMemo(() => {
    if (!spot || !size.width || !size.height) return [];
    return spot.links.map((link) => ({ link, point: projectSphericalPoint(link, view, size.width, size.height) }));
  }, [size.height, size.width, spot, view]);

  const unreachable = draft ? unreachableSpots(draft) : [];
  const otherSpots = draft && spot ? draft.spots.filter((item) => item.id !== spot.id) : [];

  if (notFound) {
    return (
      <div className={styles.message}>
        <h1>Tour not found</h1>
        <p>It may have been deleted. <Link href="/tours">See all house tours</Link></p>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className={styles.message}>
        <h1>The tour could not be loaded</h1>
        <p role="alert">{loadError}</p>
        <Link href="/tours">Back to house tours</Link>
      </div>
    );
  }
  if (!draft || !spot) {
    return (
      <div className={styles.message} role="status">
        <Loader2 aria-hidden="true" className={styles.spin} /> Loading the tour…
      </div>
    );
  }

  const src = panoramaUrl(spot.projectId);
  const failed = failedSpots.has(spot.id);

  return (
    <div className={styles.shell} data-editing={editing}>
      <header className={styles.topBar}>
        <Link href="/" aria-label="Astra3D home" className={styles.brand}><BrandMark /></Link>
        <div className={styles.title}>
          <strong>{draft.name}</strong>
          <span><MapPin aria-hidden="true" /> {spot.name}</span>
        </div>
        <div className={styles.topActions}>
          <Link href="/tours" className={styles.topButton}><ArrowLeft aria-hidden="true" /> Tours</Link>
          <button
            type="button"
            className={styles.topButton}
            aria-pressed={editing}
            onClick={() => {
              setEditing((value) => !value);
              setPlacingTarget(null);
            }}
          >
            {editing ? <><Eye aria-hidden="true" /> Preview</> : <><Pencil aria-hidden="true" /> Edit arrows</>}
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <div
          ref={setStage}
          className={styles.stage}
          data-placing={placingTarget ? "true" : "false"}
          role="application"
          aria-label={`360° view of ${spot.name}. Drag or use the arrow keys to look around; W or up arrow walks to the room ahead.`}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
        >
          <PanoramaCanvas
            key={spot.id}
            src={src}
            posterSrc={src}
            posterAlt={`${spot.name}, 360° photo`}
            yaw={view.yaw}
            pitch={view.pitch}
            fov={view.fov}
            interactiveFallback
            onFailure={() => setFailedSpots((current) => new Set(current).add(spot.id))}
          />

          <div className={styles.overlay}>
            {projected.map(({ link, point }) => point.visible ? (
              <button
                key={link.id}
                type="button"
                className={styles.doorArrow}
                style={{ left: point.x, top: point.y }}
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onClick={() => goTo(link.targetSpotId)}
                aria-label={`Go to ${spotName(link.targetSpotId)}`}
              >
                <ChevronUp aria-hidden="true" />
                <span>{spotName(link.targetSpotId)}</span>
              </button>
            ) : null)}
          </div>

          {spot.links.length > 0 ? (
            <nav className={styles.compass} aria-label="Walk to another room">
              <div className={styles.compassRing}>
                {spot.links.map((link) => {
                  const relative = shortestAngleDelta(view.yaw, link.yaw);
                  return (
                    <button
                      key={link.id}
                      type="button"
                      className={styles.compassArrow}
                      style={{ transform: `rotate(${relative}deg) translateY(-2.6rem)` }}
                      onPointerDown={(event) => event.stopPropagation()}
                      onPointerUp={(event) => event.stopPropagation()}
                      onClick={() => goTo(link.targetSpotId)}
                      aria-label={`Walk to ${spotName(link.targetSpotId)}`}
                      title={spotName(link.targetSpotId)}
                    >
                      <ChevronUp aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </nav>
          ) : null}

          {failed ? (
            <div className={styles.stageNotice} role="alert">
              The 360° photo of {spot.name} is missing from the studio.{editing ? " Remove this room or add it again." : ""}
            </div>
          ) : null}
          {placingTarget ? (
            <div className={styles.placingBanner} role="status">
              <span>Click where the way to <strong>{spotName(placingTarget)}</strong> is: the doorway, or the floor in that direction.</span>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onClick={() => setPlacingTarget(null)}
              >
                Cancel
              </button>
            </div>
          ) : null}
          {!editing && spot.links.length === 0 && draft.spots.length > 1 ? (
            <div className={styles.stageNotice}>No arrows in this room yet. Use “Edit arrows” to connect the rooms.</div>
          ) : null}
          <div className={styles.fade} data-visible={fading} aria-hidden="true" />
        </div>

        {editing ? (
          <aside className={styles.editor} aria-label="Edit the tour">
            <label className={studio.roomNameField}>
              <span>Tour name</span>
              <input value={draft.name} maxLength={60} onChange={(event) => update({ ...draft, name: event.target.value })} />
            </label>

            <section className={styles.editorSection} aria-labelledby="spot-heading">
              <h2 id="spot-heading">This room</h2>
              <label className={studio.roomNameField}>
                <span>Room name</span>
                <input value={spot.name} maxLength={48} onChange={(event) => updateSpot(spot.id, { name: event.target.value })} />
              </label>
              <div className={styles.row}>
                <button type="button" className={styles.smallButton} onClick={() => updateSpot(spot.id, { startYaw: Math.round(view.yaw) })}>
                  <RotateCcw aria-hidden="true" /> Start facing this way
                </button>
                <button
                  type="button"
                  className={styles.smallButton}
                  disabled={draft.startSpotId === spot.id}
                  onClick={() => update({ ...draft, startSpotId: spot.id })}
                >
                  <Flag aria-hidden="true" /> {draft.startSpotId === spot.id ? "Tour starts here" : "Start the tour here"}
                </button>
              </div>
            </section>

            <section className={styles.editorSection} aria-labelledby="arrows-heading">
              <h2 id="arrows-heading">Arrows in this room</h2>
              {spot.links.length === 0 ? <p className={styles.hint}>No arrows yet. Add one for each doorway.</p> : null}
              <ul className={styles.linkList}>
                {spot.links.map((link) => (
                  <li key={link.id}>
                    <span>→ {spotName(link.targetSpotId)}</span>
                    <button type="button" onClick={() => setView((current) => ({ ...current, yaw: link.yaw, pitch: clampPitch(link.pitch + 15) }))} aria-label={`Look at the arrow to ${spotName(link.targetSpotId)}`}>
                      <Eye aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => update(removeLink(draft, spot.id, link.id))} aria-label={`Remove the arrow to ${spotName(link.targetSpotId)}`}>
                      <Trash2 aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              {otherSpots.length > 0 ? (
                <div className={styles.row}>
                  <select value={arrowTarget} onChange={(event) => setArrowTarget(event.target.value)} aria-label="Room the new arrow leads to">
                    <option value="">Arrow to…</option>
                    {otherSpots.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  <button type="button" className={styles.smallButton} disabled={!arrowTarget} onClick={() => setPlacingTarget(arrowTarget)}>
                    <Plus aria-hidden="true" /> Place arrow
                  </button>
                </div>
              ) : <p className={styles.hint}>Add more rooms below to connect them with arrows.</p>}
            </section>

            <section className={styles.editorSection} aria-labelledby="rooms-heading">
              <h2 id="rooms-heading">Rooms ({draft.spots.length})</h2>
              <ul className={styles.roomList}>
                {draft.spots.map((item) => (
                  <li key={item.id} data-current={item.id === spot.id}>
                    <button type="button" onClick={() => goTo(item.id, { instant: true })} disabled={item.id === spot.id}>
                      {item.name}
                      <small>{item.links.length} {item.links.length === 1 ? "arrow" : "arrows"}{item.id === draft.startSpotId ? " · start" : ""}</small>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRoom(item.id)}
                      disabled={draft.spots.length <= 1}
                      aria-label={`Remove ${item.name} from the tour`}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              {unreachable.length > 0 ? (
                <p className={styles.warning}>No arrow leads to {unreachable.map((item) => item.name).join(", ")} yet.</p>
              ) : null}
              {rooms === null ? <p className={styles.hint}>Loading studio rooms…</p> : null}
              {rooms && rooms.length > 0 ? (
                <details className={styles.addRooms}>
                  <summary>Add rooms from the studio</summary>
                  <ul>
                    {rooms.map((room) => (
                      <li key={room.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={roomsToAdd.has(room.id)}
                            onChange={(event) => setRoomsToAdd((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(room.id);
                              else next.delete(room.id);
                              return next;
                            })}
                          />
                          {room.name}
                          <small>{new Date(room.createdAt).toLocaleDateString()}</small>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className={styles.smallButton} disabled={roomsToAdd.size === 0} onClick={addRooms}>
                    <Plus aria-hidden="true" /> Add {roomsToAdd.size || ""} {roomsToAdd.size === 1 ? "room" : "rooms"}
                  </button>
                </details>
              ) : null}
              <p className={styles.hint}>Need another spot? <Link href="/studio">Make a 360° in the studio</Link>, then add it here.</p>
            </section>

            <div className={styles.saveBar}>
              <button type="button" className={studio.primaryButton} onClick={() => void save()} disabled={!dirty || saving === "saving"}>
                {saving === "saving" ? <Loader2 aria-hidden="true" className={styles.spin} /> : <Save aria-hidden="true" />}
                {saving === "saving" ? "Saving…" : dirty ? "Save tour" : "Saved"}
              </button>
              <button type="button" className={styles.smallButton} onClick={() => void remove()}>
                <Trash2 aria-hidden="true" /> Delete tour
              </button>
            </div>
            {saveError ? <p className={studio.errorMessage} role="alert">{saveError}</p> : null}
          </aside>
        ) : null}
      </div>

      {notice ? (
        <div className={styles.toast} role="status">
          <span>{notice.text}</span>
          {notice.goToSpotId ? (
            <button
              type="button"
              onClick={() => {
                const target = notice.goToSpotId!;
                setNotice(null);
                goTo(target);
                setArrowTarget(spotId ?? "");
              }}
            >
              Go there
            </button>
          ) : null}
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss"><X aria-hidden="true" /></button>
        </div>
      ) : null}
    </div>
  );
}
