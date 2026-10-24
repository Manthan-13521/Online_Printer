import React, { useEffect, useRef, useState, useCallback } from "react";
import { formatInr } from "@printgo/pricing";

export interface PriorityPrintingCardProps {
  feePaise: number;
  isPriority: boolean;
  disabled?: boolean;
  onToggle: (checked: boolean) => void;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  life: number;
  decay: number;
}

interface ElectricArc {
  segments: Array<{ x: number; y: number }>;
  life: number;
  decay: number;
  color: string;
  width: number;
}

export function PriorityPrintingCard({
  feePaise,
  isPriority,
  disabled = false,
  onToggle,
}: PriorityPrintingCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shockwaveRef = useRef<HTMLDivElement>(null);

  const [isJittering, setIsJittering] = useState(false);
  const [isPopping, setIsPopping] = useState(false);

  const prevPriorityRef = useRef(isPriority);
  const animFrameRef = useRef<number | null>(null);
  const sparksRef = useRef<Spark[]>([]);
  const arcsRef = useRef<ElectricArc[]>([]);

  // Spawn procedural jagged electric lightning arc
  const spawnArc = useCallback(
    (startX: number, startY: number, width: number, height: number) => {
      const targetX = width * (0.35 + Math.random() * 0.55);
      const targetY = height * (0.2 + Math.random() * 0.6);

      const segments: Array<{ x: number; y: number }> = [];
      const steps = 6 + Math.floor(Math.random() * 5);

      for (let s = 0; s <= steps; s++) {
        const progress = s / steps;
        const straightX = startX + (targetX - startX) * progress;
        const straightY = startY + (targetY - startY) * progress;
        const jitter = (1 - progress * 0.4) * (Math.random() * 14 - 7);
        segments.push({
          x:
            s === 0
              ? startX
              : s === steps
                ? targetX
                : straightX + (Math.random() * 6 - 3),
          y: s === 0 ? startY : s === steps ? targetY : straightY + jitter,
        });
      }

      arcsRef.current.push({
        segments,
        life: 1.0,
        decay: 0.12 + Math.random() * 0.08,
        color: Math.random() > 0.4 ? "#FFFFFF" : "#FEF08A",
        width: 1.8 + Math.random() * 1.2,
      });
    },
    [],
  );

  // Trigger high-voltage spark blast from the lightning bolt
  const triggerBlast = useCallback(
    (
      originX: number,
      originY: number,
      canvasWidth: number,
      canvasHeight: number,
    ) => {
      // 1. Particle sparks
      const sparkCount = 45;
      const newSparks: Spark[] = [];
      for (let i = 0; i < sparkCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const biasAngle =
          Math.random() > 0.35 ? Math.random() * 1.4 - 0.7 : angle;
        const speed = 2.5 + Math.random() * 7.5;

        newSparks.push({
          x: originX,
          y: originY,
          vx: Math.cos(biasAngle) * speed + 1.2,
          vy: Math.sin(biasAngle) * speed,
          size: 1.5 + Math.random() * 2.5,
          color:
            Math.random() > 0.35
              ? "#FBBF24"
              : Math.random() > 0.5
                ? "#FFFFFF"
                : "#F59E0B",
          life: 1.0,
          decay: 0.025 + Math.random() * 0.035,
        });
      }
      sparksRef.current = [...sparksRef.current, ...newSparks];

      // 2. Jagged arcs
      for (let j = 0; j < 3; j++) {
        spawnArc(originX, originY, canvasWidth, canvasHeight);
      }

      // 3. Shockwave rings
      if (shockwaveRef.current) {
        shockwaveRef.current.innerHTML = "";
        for (let r = 0; r < 2; r++) {
          const ring = document.createElement("div");
          ring.className = "shockwave-ring";
          ring.style.animationDelay = `${r * 0.12}s`;
          shockwaveRef.current.appendChild(ring);
          setTimeout(() => {
            ring.remove();
          }, 750);
        }
      }
    },
    [spawnArc],
  );

  // Synchronize canvas size
  const syncCanvasSize = useCallback(() => {
    if (!canvasRef.current || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    canvasRef.current.width = rect.width;
    canvasRef.current.height = rect.height;
  }, []);

  // Handle priority changes
  useEffect(() => {
    let jitterTimer: ReturnType<typeof setTimeout> | undefined;
    let popTimer: ReturnType<typeof setTimeout> | undefined;

    if (isPriority && !prevPriorityRef.current) {
      // Just activated!
      setIsJittering(true);
      setIsPopping(true);

      jitterTimer = setTimeout(() => setIsJittering(false), 380);
      popTimer = setTimeout(() => setIsPopping(false), 420);

      syncCanvasSize();
      const canvas = canvasRef.current;
      const originX = 36;
      const originY = canvas ? canvas.height / 2 : 28;
      triggerBlast(
        originX,
        originY,
        canvas?.width || 300,
        canvas?.height || 60,
      );
    } else if (!isPriority && prevPriorityRef.current) {
      // Deactivated
      sparksRef.current = [];
      arcsRef.current = [];
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    prevPriorityRef.current = isPriority;

    return () => {
      if (jitterTimer) clearTimeout(jitterTimer);
      if (popTimer) clearTimeout(popTimer);
    };
  }, [isPriority, syncCanvasSize, triggerBlast]);

  // Main Canvas Render Loop
  useEffect(() => {
    if (!isPriority) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      return;
    }

    syncCanvasSize();
    window.addEventListener("resize", syncCanvasSize);

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Subtle ambient sparks hop off the active bolt
      if (Math.random() < 0.28) {
        sparksRef.current.push({
          x: 36 + (Math.random() * 12 - 6),
          y: canvas.height / 2 + (Math.random() * 16 - 8),
          vx: (Math.random() * 3.5 - 1.2) * 1.1,
          vy: Math.random() * 3.5 - 1.75,
          size: 1.2 + Math.random() * 1.8,
          color: Math.random() > 0.5 ? "#FBBF24" : "#FFFFFF",
          life: 0.85,
          decay: 0.035 + Math.random() * 0.03,
        });
      }

      // Occasional gentle electric arc
      if (Math.random() < 0.04) {
        spawnArc(36, canvas.height / 2, canvas.width, canvas.height);
      }

      // 1. Draw Arcs
      for (let a = arcsRef.current.length - 1; a >= 0; a--) {
        const arc = arcsRef.current[a];
        if (!arc) continue;
        arc.life -= arc.decay;

        if (arc.life <= 0) {
          arcsRef.current.splice(a, 1);
          continue;
        }

        ctx.save();
        ctx.strokeStyle = arc.color;
        ctx.lineWidth = Math.max(0.8, arc.width * arc.life);
        ctx.shadowColor = "#F59E0B";
        ctx.shadowBlur = 10;
        ctx.globalAlpha = arc.life;

        ctx.beginPath();
        for (let p = 0; p < arc.segments.length; p++) {
          const pt = arc.segments[p];
          if (!pt) continue;
          if (p === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();

        // White core highlight
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = Math.max(0.5, arc.width * 0.35 * arc.life);
        ctx.shadowBlur = 3;
        ctx.stroke();

        ctx.restore();
      }

      // 2. Draw Sparks
      for (let i = sparksRef.current.length - 1; i >= 0; i--) {
        const sp = sparksRef.current[i];
        if (!sp) continue;
        sp.x += sp.vx;
        sp.y += sp.vy;
        sp.life -= sp.decay;

        if (sp.life <= 0) {
          sparksRef.current.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.fillStyle = sp.color;
        ctx.shadowColor = "#F59E0B";
        ctx.shadowBlur = 6;
        ctx.globalAlpha = sp.life;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, Math.max(0.5, sp.size * sp.life), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", syncCanvasSize);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [isPriority, syncCanvasSize, spawnArc]);

  const handleCardClick = () => {
    if (disabled) return;
    onToggle(!isPriority);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onToggle(!isPriority);
    }
  };

  const thunderClass = isPriority
    ? isPopping
      ? "priority-bolt-svg thunder-burst-in"
      : "priority-bolt-svg thunder-active"
    : "priority-bolt-svg";

  return (
    <div
      ref={cardRef}
      tabIndex={disabled ? -1 : 0}
      onClick={handleCardClick}
      onKeyDown={handleKeyDown}
      className={`priority-selector ${isPriority ? "active" : ""} ${
        isJittering ? "card-jitter" : ""
      }`}
      style={{
        opacity: disabled ? 0.7 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {/* Procedural Canvas Overlay for Live Lightning & Sparks */}
      <canvas ref={canvasRef} className="priority-canvas-overlay" />

      {/* Shockwave expanding rings container */}
      <div ref={shockwaveRef} className="priority-shockwave-container" />

      {/* Ambient warm golden glow overlay */}
      <div className="priority-ambient-glow" />

      {/* Running SVG Electric Circuit Border Overlay */}
      {isPriority && (
        <svg
          className="priority-circuit-svg"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id="pgElectricGradGlow"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="#FEF08A" />
              <stop offset="35%" stopColor="#FBBF24" />
              <stop offset="70%" stopColor="#F59E0B" />
              <stop offset="100%" stopColor="#EA580C" />
            </linearGradient>
            <linearGradient
              id="pgElectricCoreWhite"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="50%" stopColor="#FEF08A" />
              <stop offset="100%" stopColor="#FFFFFF" />
            </linearGradient>
          </defs>
          <rect
            x="1.5"
            y="1.5"
            width="calc(100% - 3px)"
            height="calc(100% - 3px)"
            rx="15"
            ry="15"
            fill="none"
            stroke="url(#pgElectricGradGlow)"
            strokeWidth="3.5"
            className="circuit-stroke-glow"
          />
          <rect
            x="1.5"
            y="1.5"
            width="calc(100% - 3px)"
            height="calc(100% - 3px)"
            rx="15"
            ry="15"
            fill="none"
            stroke="url(#pgElectricCoreWhite)"
            strokeWidth="1.8"
            className="circuit-stroke-core"
          />
        </svg>
      )}

      {/* Left: Electric Lightning Bolt + Title & Description */}
      <div className="priority-content">
        <div className="priority-icon-wrapper">
          <div className="priority-icon-aura" />
          <svg
            className={thunderClass}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M13 2.5L3.5 13.5H11.5L10.5 21.5L20.5 9.5H12.5L13 2.5Z"
              fill="#EAA013"
              stroke="#D97706"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div className="priority-text">
          <label>
            Priority Printing
            <span className="priority-fee">(+{formatInr(feePaise)})</span>
          </label>
          <p>Fast-track your job in the print queue.</p>
        </div>
      </div>

      {/* Right: Checkbox Visual with Golden Starburst Accents & Checkmark */}
      <div className="priority-checkbox-container">
        {/* Starburst twinkle accents around checkbox in active state */}
        {isPriority && (
          <>
            <span className="checkbox-sparkle sparkle-tl" aria-hidden="true">
              ✦
            </span>
            <span className="checkbox-sparkle sparkle-tr" aria-hidden="true">
              ★
            </span>
            <span className="checkbox-sparkle sparkle-bl" aria-hidden="true">
              ★
            </span>
            <span className="checkbox-sparkle sparkle-br" aria-hidden="true">
              ✦
            </span>
          </>
        )}

        <div
          className={`priority-checkbox-visual ${isPriority ? "checked" : ""}`}
        >
          {isPriority && (
            <svg
              className="priority-check-tick"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
        </div>

        {/* Hidden Accessible Checkbox Input for Form & Test Parity */}
        <input
          type="checkbox"
          checked={isPriority}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="priority-checkbox priority-checkbox-input"
          aria-label={`Priority Printing (+${formatInr(feePaise)})`}
          tabIndex={-1}
        />
      </div>
    </div>
  );
}
