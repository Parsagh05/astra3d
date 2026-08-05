"use client";

import dynamic from "next/dynamic";
import {
  Check,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  ShoppingBag,
  X,
} from "lucide-react";
import {
  Component,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import type { TourProduct } from "@/types/tour";

import styles from "./tour.module.css";

const ProductScene = dynamic(
  () => import("./product-scene").then((module) => module.ProductScene),
  {
    loading: () => null,
    ssr: false,
  },
);

type ProductViewerProps = {
  product: TourProduct;
  enhancedAvailable: boolean;
  onClose: () => void;
};

type ProductErrorBoundaryProps = {
  children: ReactNode;
  onError: () => void;
};

class ProductErrorBoundary extends Component<ProductErrorBoundaryProps> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type DragState = {
  pointerId: number;
  startX: number;
  startRotation: number;
};

export function ProductViewer({
  product,
  enhancedAvailable,
  onClose,
}: ProductViewerProps) {
  const titleId = useId();
  const instructionsId = useId();
  const dragRef = useRef<DragState | null>(null);
  const [finishId, setFinishId] = useState(product.defaultFinishId);
  const [rotation, setRotation] = useState(0.28);
  const [zoom, setZoom] = useState(1);
  const [added, setAdded] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [productFailed, setProductFailed] = useState(false);

  const finish = useMemo(
    () =>
      product.finishes.find((candidate) => candidate.id === finishId) ??
      product.finishes[0],
    [finishId, product.finishes],
  );

  const rotateBy = (amount: number) => {
    setRotation((current) => current + amount);
  };

  const resetView = () => {
    setRotation(0.28);
    setZoom(1);
    setAnnouncement("Product view reset");
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startRotation: rotation,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    setRotation(drag.startRotation + (event.clientX - drag.startX) * 0.012);
  };

  const endPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      rotateBy(-0.2);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      rotateBy(0.2);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom((current) => Math.min(1.35, current + 0.1));
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      setZoom((current) => Math.max(0.78, current - 0.1));
    } else if (event.key === "Home") {
      event.preventDefault();
      resetView();
    }
  };

  const selectFinish = (id: string, name: string) => {
    setFinishId(id);
    setAnnouncement(`${name} finish selected`);
  };

  const addToDemoBag = () => {
    setAdded(true);
    setAnnouncement(`${product.name} added to the local demo bag`);
  };

  if (!finish) return null;

  const canRender3d = enhancedAvailable && !productFailed;

  return (
    <section
      className={styles.productPanel}
      aria-labelledby={titleId}
      data-product-id={product.id}
      data-product-finish={finish.id}
      data-product-added={added}
      data-product-renderer={canRender3d ? "3d" : "static"}
    >
      <div className={styles.panelTopline}>
        <span>Interactive product</span>
        <button
          type="button"
          data-panel-autofocus
          onClick={onClose}
          aria-label="Close product details"
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <div
        className={styles.productStage}
        role={canRender3d ? "group" : "img"}
        tabIndex={canRender3d ? 0 : undefined}
        aria-label={
          canRender3d
            ? `Interactive 3D view of ${product.name}`
            : `Static product preview of ${product.name}`
        }
        aria-describedby={instructionsId}
        data-product-rotation={rotation.toFixed(3)}
        data-product-zoom={zoom.toFixed(2)}
        onKeyDown={canRender3d ? handleKeyDown : undefined}
        onPointerDown={canRender3d ? handlePointerDown : undefined}
        onPointerMove={canRender3d ? handlePointerMove : undefined}
        onPointerUp={canRender3d ? endPointerDrag : undefined}
        onPointerCancel={canRender3d ? endPointerDrag : undefined}
      >
        <div
          className={styles.productFallback}
          style={{ backgroundColor: finish.swatch }}
          aria-hidden="true"
        />
        {canRender3d ? (
          <ProductErrorBoundary onError={() => setProductFailed(true)}>
            <ProductScene
              color={finish.swatch}
              productId={product.id}
              rotation={rotation}
              zoom={zoom}
              onFailure={() => setProductFailed(true)}
            />
          </ProductErrorBoundary>
        ) : null}
        <p id={instructionsId} className={styles.stageHint}>
          {canRender3d
            ? "Drag to rotate. Use arrow keys, plus, minus, or Home while focused."
            : "3D rendering is unavailable. Finish choices and product details remain accessible."}
        </p>
      </div>

      {canRender3d ? (
      <div
        className={styles.productControls}
        role="group"
        aria-label="Product view controls"
      >
        <button type="button" onClick={() => rotateBy(-0.24)}>
          <RotateCcw aria-hidden="true" /> Rotate left
        </button>
        <button type="button" onClick={() => rotateBy(0.24)}>
          <RotateCw aria-hidden="true" /> Rotate right
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => setZoom((current) => Math.max(0.78, current - 0.1))}
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => setZoom((current) => Math.min(1.35, current + 0.1))}
        >
          <Plus aria-hidden="true" />
        </button>
        <button type="button" onClick={resetView}>
          Reset
        </button>
      </div>
      ) : null}

      <div className={styles.productCopy}>
        <p>{product.eyebrow}</p>
        <h2 id={titleId}>{product.name}</h2>
        <div className={styles.productPrice}>
          <strong>{product.commerce.displayPrice}</strong>
          <span>{product.commerce.availabilityLabel}</span>
        </div>
        <p>{product.description}</p>
      </div>

      <fieldset className={styles.finishPicker}>
        <legend>Choose a finish</legend>
        <div>
          {product.finishes.map((candidate) => (
            <label key={candidate.id}>
              <input
                type="radio"
                name={`${product.id}-finish`}
                value={candidate.id}
                checked={candidate.id === finish.id}
                onChange={() => selectFinish(candidate.id, candidate.name)}
              />
              <span
                className={styles.finishSwatch}
                style={{ backgroundColor: candidate.swatch }}
                aria-hidden="true"
              />
              <span>
                <strong>{candidate.name}</strong>
                <small>{candidate.material}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <ul className={styles.productDetails}>
        {product.details.map((detail) => (
          <li key={detail}>{detail}</li>
        ))}
      </ul>

      <button
        className={styles.demoBagButton}
        type="button"
        data-added={added}
        onClick={addToDemoBag}
      >
        {added ? <Check aria-hidden="true" /> : <ShoppingBag aria-hidden="true" />}
        {added ? "Added to demo bag" : product.commerce.ctaLabel}
      </button>
      <small className={styles.commerceDisclosure}>
        {product.commerce.disclosure}
      </small>
      <p className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}
