"use client";

import { ArrowLeft, Camera, Footprints, Loader2, Map as MapIcon, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import studio from "@/components/room-capture/room-capture.module.css";
import { fetchSharedProjects } from "@/components/room-capture/shared-projects-api";
import { newTourItemId } from "@/lib/house-tour";
import type { SharedRoomProject } from "@/types/capture";
import type { HouseTour } from "@/types/house-tour";

import { createTour, deleteTour, fetchTours, panoramaUrl } from "./house-tour-api";
import styles from "./house-tour.module.css";

function arrowCount(tour: HouseTour) {
  return tour.spots.reduce((total, spot) => total + spot.links.length, 0);
}

/**
 * /tours: every house tour, and a form that makes a new one from the 360°
 * rooms already saved in the studio.
 */
export function HouseTourLibrary() {
  const router = useRouter();
  const [tours, setTours] = useState<HouseTour[] | null>(null);
  const [rooms, setRooms] = useState<SharedRoomProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [loadedTours, loadedRooms] = await Promise.all([fetchTours(), fetchSharedProjects().catch(() => [] as SharedRoomProject[])]);
      setTours(loadedTours);
      setRooms(loadedRooms);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Tours could not be loaded.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const toggle = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const create = async () => {
    if (!rooms || selected.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      // Rooms keep the order they were ticked in: usually the walking order.
      const spots = selected
        .map((id) => rooms.find((room) => room.id === id))
        .filter((room): room is SharedRoomProject => room !== undefined)
        .map((room) => ({ id: newTourItemId(), projectId: room.id, name: room.name, startYaw: 0, links: [] }));
      const tour = await createTour({ name: name.trim() || "My house", startSpotId: spots[0].id, spots });
      router.push(`/tours/${tour.id}?edit=1`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The tour could not be created.");
      setCreating(false);
    }
  };

  const remove = async (tour: HouseTour) => {
    if (!window.confirm(`Delete the tour “${tour.name}”? The 360° rooms stay in the studio.`)) return;
    try {
      await deleteTour(tour.id);
      await refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "The tour could not be deleted.");
    }
  };

  return (
    <div className={studio.studioShell}>
      <header className={studio.studioHeader}>
        <Link href="/" aria-label="Astra3D home"><BrandMark /></Link>
        <div><span aria-hidden="true" /> House tours</div>
        <Link href="/studio" className={studio.backLink}><ArrowLeft aria-hidden="true" /> Photo 360 studio</Link>
      </header>

      <main className={`${studio.studioMain} ${styles.library}`}>
        <section className={styles.libraryIntro} aria-labelledby="tours-title">
          <p className={studio.kicker}><Footprints aria-hidden="true" /> Walk-through tour</p>
          <h1 id="tours-title">Walk through the house</h1>
          <p className={styles.lead}>
            Like Street View or GeoGuessr: stand in a 360° photo of a room, look around, and click the arrows to
            walk to the next room. No GPU needed, and it stays sharp because every view is a real photo.
          </p>
          <ol className={styles.steps}>
            <li><strong>Photograph each spot.</strong> In the <Link href="/studio">Create 360 studio</Link>, make a 360° in the middle of every room (big rooms and hallways can have two or three spots).</li>
            <li><strong>Make a tour.</strong> Tick the rooms below in the order you would walk through them.</li>
            <li><strong>Place the arrows.</strong> In each room, click where the doorway to the next room is. Do it from both sides so visitors can walk back.</li>
          </ol>
        </section>

        <section className={styles.createCard} aria-labelledby="create-title">
          <h2 id="create-title"><Plus aria-hidden="true" /> New house tour</h2>
          <label className={studio.roomNameField}>
            <span>Tour name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Our house" maxLength={60} disabled={creating} />
          </label>
          {rooms === null ? <p className={styles.hint}><Loader2 aria-hidden="true" className={styles.spin} /> Loading studio rooms…</p> : null}
          {rooms && rooms.length === 0 ? (
            <div className={styles.emptyRooms}>
              <Camera aria-hidden="true" />
              <p>No 360° rooms yet. <Link href="/studio">Make one in the studio</Link> for each room, then come back.</p>
            </div>
          ) : null}
          {rooms && rooms.length > 0 ? (
            <fieldset className={styles.roomPicker} disabled={creating}>
              <legend>Rooms to include ({selected.length} chosen)</legend>
              {rooms.map((room) => {
                const order = selected.indexOf(room.id);
                return (
                  <label key={room.id} data-selected={order >= 0}>
                    <input type="checkbox" checked={order >= 0} onChange={() => toggle(room.id)} />
                    <span className={styles.roomThumb}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- served by the projects API */}
                      <img src={panoramaUrl(room.id)} alt="" loading="lazy" />
                    </span>
                    <span className={styles.roomText}>
                      <strong>{room.name}</strong>
                      <small>{new Date(room.createdAt).toLocaleString()}</small>
                    </span>
                    {order >= 0 ? <b className={styles.orderBadge}>{order + 1}</b> : null}
                  </label>
                );
              })}
            </fieldset>
          ) : null}
          <button type="button" className={studio.primaryButton} onClick={() => void create()} disabled={creating || selected.length === 0}>
            {creating ? <Loader2 aria-hidden="true" className={styles.spin} /> : <MapIcon aria-hidden="true" />}
            {creating ? "Creating…" : "Create tour and place arrows"}
          </button>
          {error ? <p className={studio.errorMessage} role="alert">{error}</p> : null}
        </section>

        <section className={styles.tourList} aria-labelledby="your-tours-title">
          <h2 id="your-tours-title">Your tours</h2>
          {tours === null && !error ? <p className={styles.hint}>Loading…</p> : null}
          {tours && tours.length === 0 ? <p className={styles.hint}>No tours yet.</p> : null}
          <ul>
            {(tours ?? []).map((tour) => {
              const start = tour.spots.find((spot) => spot.id === tour.startSpotId) ?? tour.spots[0];
              return (
                <li key={tour.id} className={styles.tourCard}>
                  <Link href={`/tours/${tour.id}`} className={styles.tourMain}>
                    <span className={styles.roomThumb}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- served by the projects API */}
                      <img src={panoramaUrl(start.projectId)} alt="" loading="lazy" />
                    </span>
                    <span className={styles.roomText}>
                      <strong>{tour.name}</strong>
                      <small>{tour.spots.length} {tour.spots.length === 1 ? "room" : "rooms"} · {arrowCount(tour)} arrows</small>
                    </span>
                  </Link>
                  <Link href={`/tours/${tour.id}?edit=1`} className={styles.iconLink} aria-label={`Edit ${tour.name}`} title="Edit arrows">
                    <Pencil aria-hidden="true" />
                  </Link>
                  <button type="button" className={styles.iconLink} onClick={() => void remove(tour)} aria-label={`Delete ${tour.name}`} title="Delete">
                    <Trash2 aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </main>
    </div>
  );
}
