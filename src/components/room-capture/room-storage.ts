import type { GeneratedRoomRecord } from "@/types/capture";

const DATABASE_NAME = "astra3d-room-studio";
const STORE_NAME = "rooms";
const DATABASE_VERSION = 1;

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local room storage is unavailable."));
  });
}

export async function saveGeneratedRoom(room: GeneratedRoomRecord) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(room);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("The room could not be saved locally."));
  });
  database.close();
}

export async function loadGeneratedRoom() {
  const database = await openDatabase();
  const room = await new Promise<GeneratedRoomRecord | undefined>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get("latest-room");
    request.onsuccess = () => resolve(request.result as GeneratedRoomRecord | undefined);
    request.onerror = () => reject(request.error ?? new Error("The saved room could not be opened."));
  });
  database.close();
  return room;
}

export async function deleteGeneratedRoom() {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete("latest-room");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("The saved room could not be removed."));
  });
  database.close();
}
