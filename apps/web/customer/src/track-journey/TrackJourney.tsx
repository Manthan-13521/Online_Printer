import React, { useState, useEffect } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Smartphone,
  Server,
  SlidersHorizontal,
  CheckCircle2,
  Check,
  ArrowLeft,
  RefreshCw,
} from "lucide-react";

const STAGES = [
  "UPLOADING",
  "PROCESSING",
  "STAFF",
  "QUEUED",
  "PRINTING",
  "FINISHING",
  "READY",
];

const DESKTOP_PATHS = [
  "M 200,100 C 350,100 350,250 500,250",
  "M 500,250 C 650,250 700,150 850,150",
  "M 850,150 C 1000,150 950,500 800,500",
  "M 800,500 C 650,500 650,700 500,700",
  "M 500,800 C 350,800 200,600 150,600",
  "M 150,600 C 100,600 150,900 250,900",
];
const MOBILE_PATHS = [
  "M 250,50 C 500,50 500,200 750,200",
  "M 750,200 C 900,200 500,350 250,350",
  "M 250,350 C 50,350 500,500 750,500",
  "M 750,500 C 900,500 500,600 350,600",
  "M 350,700 C 200,700 500,800 750,800",
  "M 750,800 C 900,800 500,950 500,950",
];

const POSITIONS = {
  d: [
    { x: 20, y: 10 },
    { x: 50, y: 25 },
    { x: 85, y: 15 },
    { x: 80, y: 50 },
    { x: 50, y: 75 },
    { x: 15, y: 60 },
    { x: 25, y: 90 },
  ],
  m: [
    { x: 25, y: 5 },
    { x: 75, y: 20 },
    { x: 25, y: 35 },
    { x: 75, y: 50 },
    { x: 35, y: 65 },
    { x: 75, y: 80 },
    { x: 50, y: 95 },
  ],
};

export interface OrderDetails {
  orderNumber?: string;
  fileName?: string;
  pages?: number | string;
  colorMode?: string;
  paperSize?: string;
  estimatedReady?: string;
  pickupStore?: string;
  pickupLocation?: string;
  pickupCode?: string;
  isPickup?: boolean;
  isPriority?: boolean;
  statusLabel?: string;
  statusMessage?: string;
}

export interface TrackJourneyProps {
  currentStageIndex: number;
  orderDetails: OrderDetails;
  children?: React.ReactNode; // To allow passing error states or private link buttons
  onBack?: (() => void) | undefined;
}

import rawCss from "./trackJourney.css?raw";

const journeyCss = `${rawCss}
  .track-journey-root .journey-context {
    width: 100%;
    max-width: 540px;
    margin: 0 auto;
    padding: 0;
    background: transparent;
    border: none;
    box-shadow: none;
  }
  @keyframes jumpDash { to { stroke-dashoffset: var(--dash-target); } }
  .thunder-icon-active {
    transform-origin: 50% 50%;
    animation: thunderPopIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
               thunderContinuousHum 0.15s ease-in-out infinite alternate 0.5s;
  }
  @keyframes thunderPopIn {
    0% { transform: scale(0.6) rotate(15deg); opacity: 0; }
    55% { transform: scale(1.45) rotate(-14deg); filter: drop-shadow(0 0 14px #F59E0B) drop-shadow(0 0 24px #FDE047); opacity: 1; }
    100% { transform: scale(1.15) rotate(-4deg); filter: drop-shadow(0 0 8px #F59E0B) drop-shadow(0 0 16px #D97706); opacity: 1; }
  }
  @keyframes thunderContinuousHum {
    0% { transform: scale(1.15) rotate(-4deg); filter: drop-shadow(0 0 7px #F59E0B) drop-shadow(0 0 12px #FDE047); }
    100% { transform: scale(1.24) rotate(0deg); filter: drop-shadow(0 0 14px #EA580C) drop-shadow(0 0 22px #F59E0B); }
  }

  /* Golden Electric Perimeter Border (Priority Screen Chassis) */
  .priority-chassis-active {
    border: 2.5px solid #FACC15 !important;
    box-shadow:
      0 0 18px rgba(250, 204, 21, 0.45),
      0 0 38px rgba(245, 158, 11, 0.25),
      inset 0 0 14px rgba(250, 204, 21, 0.2) !important;
    animation: ambientGlowPulse 3.0s ease-in-out infinite;
  }
  @keyframes ambientGlowPulse {
    0%, 100% {
      box-shadow:
        0 0 16px rgba(250, 204, 21, 0.4),
        0 0 32px rgba(245, 158, 11, 0.2),
        inset 0 0 12px rgba(250, 204, 21, 0.18);
      border-color: #FACC15;
    }
    50% {
      box-shadow:
        0 0 24px rgba(250, 204, 21, 0.65),
        0 0 46px rgba(245, 158, 11, 0.35),
        inset 0 0 18px rgba(250, 204, 21, 0.28);
      border-color: #FEF08A;
    }
  }

  .priority-perimeter-border-shell {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 40;
    border-radius: inherit;
    overflow: hidden;
  }

  .priority-perimeter-runner {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 3px;
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    mask-composite: exclude;
    overflow: hidden;
    pointer-events: none;
  }
  .priority-perimeter-runner::before {
    content: "";
    position: absolute;
    top: -150%;
    left: -150%;
    width: 400%;
    height: 400%;
    background: conic-gradient(
      from 0deg,
      transparent 0%,
      transparent 70%,
      #FDE047 88%,
      #F59E0B 96%,
      transparent 100%
    );
    animation: spinPerimeterBeam 6.0s linear infinite;
  }
  @keyframes spinPerimeterBeam {
    to { transform: rotate(360deg); }
  }

  .priority-perimeter-crackle {
    position: absolute;
    pointer-events: none;
    filter: drop-shadow(0 0 6px #FFFFFF) drop-shadow(0 0 12px #F59E0B);
  }
  .priority-crackle-top {
    top: 0;
    left: 8%;
    right: 8%;
    height: 2.5px;
    background: linear-gradient(90deg, transparent, #FFFFFF 40%, #FEF08A 70%, transparent);
    animation: dischargeTop 0.72s ease-in-out infinite;
  }
  .priority-crackle-bottom {
    bottom: 0;
    left: 12%;
    right: 12%;
    height: 2.5px;
    background: linear-gradient(90deg, transparent, #FEF08A 30%, #FFFFFF 60%, transparent);
    animation: dischargeBottom 0.65s ease-in-out infinite 0.25s;
  }
  .priority-crackle-left {
    left: 0;
    top: 15%;
    bottom: 15%;
    width: 2.5px;
    background: linear-gradient(180deg, transparent, #FFFFFF 45%, #FACC15 75%, transparent);
    animation: dischargeSide 0.78s ease-in-out infinite 0.42s;
  }
  .priority-crackle-right {
    right: 0;
    top: 20%;
    bottom: 20%;
    width: 2.5px;
    background: linear-gradient(180deg, transparent, #FACC15 25%, #FFFFFF 55%, transparent);
    animation: dischargeSide 0.68s ease-in-out infinite 0.12s;
  }

  @keyframes dischargeTop {
    0%, 100% { opacity: 0; transform: scaleX(0.2); }
    46% { opacity: 0; }
    49% { opacity: 0.95; transform: scaleX(1); }
    53% { opacity: 0.2; }
    56% { opacity: 0.85; }
    59% { opacity: 0; }
  }
  @keyframes dischargeBottom {
    0%, 100% { opacity: 0; transform: scaleX(0.2); }
    56% { opacity: 0; }
    59% { opacity: 0.95; transform: scaleX(1); }
    63% { opacity: 0.15; }
    66% { opacity: 0.8; }
    69% { opacity: 0; }
  }
  @keyframes dischargeSide {
    0%, 100% { opacity: 0; transform: scaleY(0.2); }
    62% { opacity: 0; }
    65% { opacity: 0.9; transform: scaleY(1); }
    68% { opacity: 0.1; }
    71% { opacity: 0.85; }
    74% { opacity: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .track-journey-root * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
    .track-journey-root animateMotion, .track-journey-root animate { display: none; }
    .thunder-icon-active { animation: none !important; filter: drop-shadow(0 0 8px #f59e0b); }
    .priority-perimeter-runner::before { animation: none !important; }
    .priority-chassis-active { animation: none !important; }
    .priority-perimeter-crackle { display: none !important; }
  }`;

export default function TrackJourney({
  currentStageIndex,
  orderDetails,
  children,
  onBack,
}: TrackJourneyProps) {
  const [isMobile, setIsMobile] = useState(false);
  const reduceMotion = useReducedMotion() === true;
  const currentStage = STAGES[currentStageIndex];

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  if (currentStage === "READY") {
    return (
      <div className="track-journey-root">
        <style>{journeyCss}</style>
        <FinishedScreen orderDetails={orderDetails} onBack={onBack} />
      </div>
    );
  }

  const getStatus = (targetIndex: number) => {
    if (currentStageIndex > targetIndex) return "completed";
    if (currentStageIndex === targetIndex) return "active";
    return "pending";
  };

  const hasOrderDetails = Boolean(
    orderDetails.orderNumber ||
    orderDetails.fileName ||
    orderDetails.pages ||
    orderDetails.estimatedReady ||
    orderDetails.pickupStore ||
    orderDetails.pickupLocation,
  );

  return (
    <div className="track-journey-root min-h-screen w-full bg-printgo-bg text-printgo-primary flex flex-col font-sans relative overflow-x-hidden selection:bg-printgo-green selection:text-white">
      <style>{journeyCss}</style>

      {!children && hasOrderDetails && (
        <header className="w-full px-5 py-3 md:px-10 md:py-4 flex justify-end items-center border-b border-printgo-border bg-printgo-bg z-20 relative shrink-0">
          <div className="flex flex-col lg:flex-row lg:items-end text-xs lg:text-sm gap-2 lg:gap-12 w-full lg:w-auto">
            <div className="flex flex-col items-start lg:items-end">
              {orderDetails.orderNumber && (
                <span className="font-bold text-printgo-primary">
                  Order {orderDetails.orderNumber}
                </span>
              )}
              {orderDetails.fileName && (
                <span className="font-mono text-[10px] text-printgo-secondary">
                  {orderDetails.fileName}
                </span>
              )}
            </div>
            {(orderDetails.pages || orderDetails.estimatedReady) && (
              <div className="flex flex-col items-start lg:items-end text-printgo-secondary">
                {orderDetails.pages && (
                  <span>
                    Pages {orderDetails.pages}{" "}
                    {orderDetails.colorMode && `· ${orderDetails.colorMode}`}{" "}
                    {orderDetails.paperSize && `· ${orderDetails.paperSize}`}
                  </span>
                )}
                {orderDetails.estimatedReady && (
                  <span>
                    Estimated ready:{" "}
                    <span className="font-bold text-printgo-primary">
                      {orderDetails.estimatedReady}
                    </span>
                  </span>
                )}
              </div>
            )}
            {(orderDetails.pickupStore || orderDetails.pickupLocation) && (
              <div className="flex flex-col items-start lg:items-end text-printgo-secondary">
                {orderDetails.pickupStore && (
                  <span className="font-bold text-printgo-primary">
                    Pickup: {orderDetails.pickupStore}
                  </span>
                )}
                {orderDetails.pickupLocation && (
                  <span>{orderDetails.pickupLocation}</span>
                )}
              </div>
            )}
          </div>
        </header>
      )}

      {children && (
        <section className="journey-context" aria-live="polite">
          {children}
        </section>
      )}

      <main className="flex-1 w-full max-w-5xl mx-auto relative z-10 overflow-hidden">
        <div className="w-full h-[800px] lg:h-[950px] relative mt-1 lg:mt-4 mb-12">
          <div className="absolute inset-0 z-0">
            <svg
              className="w-full h-full"
              preserveAspectRatio="none"
              viewBox="0 0 1000 1000"
            >
              {STAGES.slice(0, 6).map((stage, idx) => {
                const path = isMobile ? MOBILE_PATHS[idx] : DESKTOP_PATHS[idx];

                const isCompleted = currentStageIndex > idx + 1;
                const isActive = currentStageIndex === idx + 1;

                return (
                  <AnimatedConnector
                    key={stage}
                    path={path || ""}
                    isCompleted={isCompleted}
                    isActive={isActive}
                  />
                );
              })}
            </svg>
          </div>

          <div className="absolute inset-0 z-40 pointer-events-none">
            <svg
              className="w-full h-full"
              preserveAspectRatio="none"
              viewBox="0 0 1000 1000"
            >
              {STAGES.slice(0, 6).map((stage, idx) => {
                if (!reduceMotion && idx < 5 && getStatus(idx) === "active") {
                  return (
                    <AnimatedPaperGroup
                      key={stage}
                      path={
                        (isMobile ? MOBILE_PATHS[idx] : DESKTOP_PATHS[idx]) ||
                        ""
                      }
                      isMobile={isMobile}
                    />
                  );
                }
                return null;
              })}
            </svg>
          </div>

          <StationNode
            pos={isMobile ? POSITIONS.m[0] : POSITIONS.d[0]}
            status={getStatus(0)}
            label="Mobile"
          >
            <Smartphone
              size={isMobile ? 24 : 32}
              strokeWidth={1.5}
              className="text-printgo-primary"
            />
          </StationNode>

          <StationNode
            pos={isMobile ? POSITIONS.m[1] : POSITIONS.d[1]}
            status={getStatus(1)}
            label="Server/cloud"
          >
            <Server
              size={isMobile ? 28 : 36}
              strokeWidth={1.5}
              className="text-printgo-primary"
            />
          </StationNode>

          <StationNode
            pos={isMobile ? POSITIONS.m[2] : POSITIONS.d[2]}
            status={getStatus(2)}
            label="Processing"
          >
            <SlidersHorizontal
              size={isMobile ? 24 : 32}
              strokeWidth={1.5}
              className="text-printgo-primary"
            />
          </StationNode>

          <StationNode
            pos={isMobile ? POSITIONS.m[3] : POSITIONS.d[3]}
            status={getStatus(3)}
            label="Print Queue"
            wide
          >
            <QueueVisual active={!reduceMotion && getStatus(3) === "active"} />
          </StationNode>

          <StationNode
            pos={isMobile ? POSITIONS.m[4] : POSITIONS.d[4]}
            status={getStatus(4)}
            label="Printer"
            isHero
          >
            <HeroPrinterVisual
              active={!reduceMotion && getStatus(4) === "active"}
            />
          </StationNode>

          <StationNode
            pos={isMobile ? POSITIONS.m[5] : POSITIONS.d[5]}
            status={getStatus(5)}
            label="Finishing"
          >
            <FinishingVisual
              active={!reduceMotion && getStatus(5) === "active"}
            />
          </StationNode>

          <StationNode
            pos={isMobile ? POSITIONS.m[6] : POSITIONS.d[6]}
            status={getStatus(6)}
            label="Ready"
          >
            <ReadyVisual active={!reduceMotion && getStatus(6) === "active"} />
          </StationNode>
        </div>
      </main>
    </div>
  );
}

interface StationNodeProps {
  pos?: { x: number; y: number } | undefined;
  status: "completed" | "active" | "pending";
  label: string;
  wide?: boolean;
  isHero?: boolean;
  children?: React.ReactNode;
}
const StationNode = ({
  pos,
  status,
  label,
  wide,
  isHero,
  children,
}: StationNodeProps) => {
  const isCompleted = status === "completed";
  const isWide = wide && !isCompleted;

  const baseSize = isWide
    ? "w-[88px] h-[64px] lg:w-[120px] lg:h-[80px]"
    : "w-[64px] h-[64px] lg:w-[86px] lg:h-[86px]";
  const heroSize = isWide
    ? "w-[96px] h-[72px] lg:w-[132px] lg:h-[88px]"
    : "w-[70.4px] h-[70.4px] lg:w-[94.6px] lg:h-[94.6px]";

  const completedCircle =
    "w-[64px] h-[64px] lg:w-[86px] lg:h-[86px] rounded-full";

  const sizing = isCompleted ? completedCircle : isHero ? heroSize : baseSize;

  const bgAndBorder = isCompleted
    ? "bg-printgo-green border-0 shadow-md"
    : `bg-white border-[2px] ${status === "active" ? "border-printgo-green/40 shadow-lg scale-110" : "border-printgo-border grayscale opacity-50"}`;

  const rounding = isCompleted ? "rounded-full" : "rounded-2xl lg:rounded-3xl";

  return (
    <div
      className="absolute flex flex-col items-center justify-center transition-all duration-700 z-10"
      style={{
        left: `${pos?.x ?? 0}%`,
        top: `${pos?.y ?? 0}%`,
        transform: "translate(-50%, -50%)",
      }}
    >
      <div
        className={`text-[9px] lg:text-xs uppercase tracking-widest font-bold mb-2 lg:mb-3 transition-colors text-center whitespace-nowrap
        ${status === "active" ? "text-printgo-green" : "text-printgo-secondary"}
        ${status === "pending" ? "opacity-50" : "opacity-100"}
      `}
      >
        {label}
      </div>

      <div
        className={`relative flex justify-center items-center transition-all duration-700 ${sizing} ${bgAndBorder} ${rounding}`}
      >
        {status === "active" && (
          <div
            className={`absolute inset-0 border-[2px] border-printgo-green/30 animate-ping z-0 ${rounding}`}
            style={{ animationDuration: "2.5s" }}
          />
        )}

        {status === "completed" ? (
          <Check
            size={28}
            strokeWidth={4}
            className="text-white lg:w-10 lg:h-10 drop-shadow-sm"
          />
        ) : (
          <div className="relative z-10 flex justify-center items-center w-full h-full text-printgo-primary">
            {children}
          </div>
        )}
      </div>
    </div>
  );
};

const AnimatedConnector = ({
  path,
  isCompleted,
  isActive,
}: {
  path: string;
  isCompleted: boolean;
  isActive: boolean;
}) => {
  const [length, setLength] = useState(0);
  const pathRef = React.useRef<SVGPathElement>(null);

  useEffect(() => {
    if (pathRef.current) {
      if (typeof pathRef.current.getTotalLength === "function") {
        setLength(pathRef.current.getTotalLength());
      } else {
        setLength(100); // fallback for jsdom/tests
      }
    }
  }, [path]);

  if (isCompleted) {
    return (
      <path
        d={path}
        fill="none"
        stroke="#176B45"
        strokeWidth="6"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className="opacity-100 transition-colors duration-700"
      />
    );
  }

  const period = 24;

  if (isActive && length > 0) {
    const steps = Math.ceil(length / period);
    const duration = steps * 0.195;
    return (
      <g>
        <path
          d={path}
          fill="none"
          stroke="#CDD3CD"
          strokeWidth="6"
          strokeDasharray="12 12"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          className="opacity-100 transition-colors duration-700"
        />

        <path
          d={path}
          fill="none"
          stroke="#176B45"
          strokeWidth="7.5"
          strokeLinecap="round"
          strokeDasharray={`14 ${length + 100}`}
          vectorEffect="non-scaling-stroke"
          style={
            {
              "--dash-target": `-${steps * period}px`,
              animation: `jumpDash ${duration}s steps(${steps}, start) infinite`,
            } as React.CSSProperties
          }
        />
      </g>
    );
  }

  return (
    <path
      ref={pathRef}
      d={path}
      fill="none"
      stroke="#CDD3CD"
      strokeWidth="6"
      strokeDasharray="12 12"
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
      className="opacity-40 transition-colors duration-700"
    />
  );
};

const AnimatedPaperGroup = ({
  path,
  isMobile,
}: {
  path: string;
  isMobile: boolean;
}) => {
  const pathId = `path-${Math.random().toString(36).substr(2, 9)}`;
  const pW = isMobile ? 124 : 64;
  const pH = isMobile ? 174 : 90;
  const pX = -pW / 2;
  const pY = -pH / 2;

  return (
    <>
      <defs>
        <path id={pathId} d={path} />
      </defs>

      {[0, 1].map((i) => (
        <g key={i} opacity="0">
          <animateMotion
            dur="2.4s"
            repeatCount="indefinite"
            begin={`${i * 1.2}s`}
            rotate="auto"
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>

          <animate
            attributeName="opacity"
            values="0; 1; 1; 0"
            keyTimes="0; 0.15; 0.85; 1"
            dur="2.4s"
            repeatCount="indefinite"
            begin={`${i * 1.2}s`}
          />

          <g transform="translate(0, 0)">
            <rect
              x={pX}
              y={pY}
              width={pW}
              height={pH}
              fill="white"
              stroke="#176B45"
              strokeWidth={isMobile ? "4" : "2.5"}
              rx="2"
            />
            <rect
              x={pX + pW * 0.15}
              y={pY + pH * 0.2}
              width={pW * 0.7}
              height={isMobile ? "4" : "2"}
              fill="#176B45"
              opacity="0.4"
            />
            <rect
              x={pX + pW * 0.15}
              y={pY + pH * 0.4}
              width={pW * 0.5}
              height={isMobile ? "4" : "2"}
              fill="#CDD3CD"
            />
            <rect
              x={pX + pW * 0.15}
              y={pY + pH * 0.6}
              width={pW * 0.7}
              height={isMobile ? "4" : "2"}
              fill="#CDD3CD"
            />
          </g>
        </g>
      ))}
    </>
  );
};

const QueueVisual = ({ active }: { active: boolean }) => {
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      setHighlight((prev) => (prev + 1) % 4);
    }, 600);
    return () => clearInterval(interval);
  }, [active]);

  return (
    <div className="flex gap-[3px] lg:gap-1.5 items-end px-2 lg:px-3 w-full justify-center">
      {[0, 1, 2, 3].map((i) => {
        const isHighlighted = active && highlight === i;
        return (
          <div
            key={i}
            className={`w-[14px] h-[20px] lg:w-6 lg:h-8 border-[2px] transition-all duration-300 shadow-sm rounded-[2px] flex flex-col p-[2px] ${
              isHighlighted
                ? "border-printgo-green scale-110 bg-printgo-green/5 -translate-y-1"
                : "border-printgo-border bg-white"
            }`}
          >
            <div
              className={`w-full h-[2px] mb-[2px] ${isHighlighted ? "bg-printgo-green" : "bg-printgo-border"}`}
            />
            <div
              className={`w-3/4 h-[2px] mb-[2px] ${isHighlighted ? "bg-printgo-green/40" : "bg-printgo-border"}`}
            />
            <div
              className={`w-full h-[2px] ${isHighlighted ? "bg-printgo-green/40" : "bg-printgo-border"}`}
            />
          </div>
        );
      })}
    </div>
  );
};

const HeroPrinterVisual = ({ active }: { active: boolean }) => (
  <svg
    viewBox="0 0 100 100"
    className="w-full h-full p-1"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M28 36V23Q28 20 31 20H69Q72 20 72 23V36" fill="#F7F5F0" />
    <motion.g
      key={String(active)}
      initial={false}
      animate={
        active
          ? { y: [-7, -7, 19, 19, -7], opacity: [1, 1, 0, 0, 1] }
          : { y: 0, opacity: 1 }
      }
      transition={{
        duration: 2.4,
        repeat: Infinity,
        times: [0, 0.15, 0.4, 0.95, 1],
        ease: "easeInOut",
      }}
    >
      <rect x="32" y="9" width="36" height="51" rx="2" fill="white" />
    </motion.g>
    <path d="M24 67L19 88Q19 91 23 91H77Q81 91 81 88L76 67" fill="#F7F5F0" />
    <motion.g
      key={`output-${active}`}
      initial={false}
      animate={
        active
          ? { y: [-24, -24, 0, 5, 5], opacity: [0, 0, 1, 1, 0] }
          : { y: 0, opacity: 1 }
      }
      transition={{
        duration: 2.4,
        repeat: Infinity,
        times: [0, 0.42, 0.72, 0.9, 1],
        ease: "easeInOut",
      }}
    >
      <rect x="32" y="38" width="36" height="51" rx="2" fill="white" />
      <path
        d="M39 73H61M39 78H57M39 83H61"
        stroke="#176B45"
        strokeWidth="1.8"
      />
    </motion.g>
    <rect x="14" y="34" width="72" height="35" rx="7" fill="white" />
    <path d="M15 46H85" stroke="#CDD3CD" strokeWidth="1.5" />
    <path d="M29 35H71" />
    <motion.circle
      cx="75"
      cy="41"
      r="2"
      stroke="none"
      fill={active ? "#176B45" : "#737A74"}
      animate={active ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
      transition={{ duration: 0.6, repeat: Infinity }}
    />
    <rect
      x="26"
      y="57"
      width="48"
      height="7"
      rx="2"
      fill="#182019"
      stroke="none"
    />
    <path d="M32 65H68" stroke="#737A74" strokeWidth="1.5" />
  </svg>
);

const FinishingVisual = ({ active }: { active: boolean }) => (
  <svg
    viewBox="0 0 100 100"
    className="w-full h-full p-1"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="15" y="85" width="70" height="4" rx="2" fill="#F7F5F0" />
    <rect
      x="30"
      y="15"
      width="40"
      height="70"
      rx="3"
      fill="white"
      stroke="#737A74"
    />
    <path d="M38 25H62M38 33H62M38 41H54" stroke="#176B45" strokeWidth="1.8" />
    <motion.g
      initial={false}
      animate={active ? { y: [0, 50, 0, 50, 0] } : { y: 0 }}
      transition={{ duration: 3, ease: "easeInOut", repeat: Infinity }}
    >
      <rect
        x="25"
        y="20"
        width="50"
        height="15"
        rx="3"
        fill="white"
        stroke="#176B45"
        strokeWidth="2.5"
      />
      <line
        x1="30"
        y1="27.5"
        x2="70"
        y2="27.5"
        stroke="#176B45"
        strokeWidth="2"
        strokeDasharray="4 4"
      />
    </motion.g>
  </svg>
);

const ReadyVisual = ({ active }: { active: boolean }) => (
  <svg
    viewBox="0 0 100 100"
    className="w-full h-full p-1"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path
      d="M22 36L78 36L70 42H30L22 36Z"
      fill="#E8ECEB"
      stroke="#176B45"
      strokeWidth="1.5"
    />

    <motion.g
      key={`paper1-${active}`}
      initial={false}
      animate={
        active
          ? {
              y: [-60, -60, 0, 5],
              rotate: [-5, -5, -2, -3],
              opacity: [0, 0, 1, 1],
            }
          : { y: 5, rotate: -3, opacity: 1 }
      }
      transition={{
        duration: 1.2,
        delay: 0.5,
        times: [0, 0.2, 0.8, 1],
        ease: "easeOut",
      }}
      style={{ transformOrigin: "50px 65px" }}
    >
      <rect
        x="36"
        y="10"
        width="32"
        height="42"
        rx="2"
        fill="#F7F5F0"
        stroke="#737A74"
        strokeWidth="1.5"
      />
      <path
        d="M41 20H59M41 26H59M41 32H50"
        stroke="#737A74"
        strokeWidth="1.5"
      />
    </motion.g>

    <motion.g
      key={`paper2-${active}`}
      initial={false}
      animate={
        active
          ? { y: [-60, -60, 2, 7], rotate: [5, 5, 2, 1], opacity: [0, 0, 1, 1] }
          : { y: 7, rotate: 1, opacity: 1 }
      }
      transition={{
        duration: 1.2,
        delay: 1.7,
        times: [0, 0.2, 0.8, 1],
        ease: "easeOut",
      }}
      style={{ transformOrigin: "50px 65px" }}
    >
      <rect
        x="33"
        y="14"
        width="34"
        height="46"
        rx="2"
        fill="white"
        stroke="#176B45"
        strokeWidth="1.5"
      />
      <path
        d="M40 24H58M40 30H58M40 36H52"
        stroke="#176B45"
        strokeWidth="1.8"
      />
    </motion.g>

    <path
      d="M22 36L18 80C17.5 84 20 86 24 86H76C80 86 82.5 84 82 80L78 36H22Z"
      fill="white"
      stroke="#176B45"
      strokeWidth="2.2"
    />
    <path d="M36 44C36 28 64 28 64 44" stroke="#176B45" strokeWidth="2.5" />
    <circle
      cx="36"
      cy="44"
      r="2.5"
      fill="white"
      stroke="#737A74"
      strokeWidth="1.5"
    />
    <circle
      cx="64"
      cy="44"
      r="2.5"
      fill="white"
      stroke="#737A74"
      strokeWidth="1.5"
    />
    <path d="M72 40L76 80" stroke="#CDD3CD" strokeWidth="1" />
  </svg>
);

function FinishedScreen({
  orderDetails,
  onBack,
}: {
  orderDetails: OrderDetails;
  onBack?: (() => void) | undefined;
}) {
  const reduceMotion = useReducedMotion() === true;
  const activeCode = orderDetails.pickupCode ?? orderDetails.orderNumber ?? "";
  const isPriority = Boolean(orderDetails.isPriority);

  const handleBackAction = () => {
    if (onBack) {
      onBack();
    } else {
      window.history.pushState(null, "", "/");
      window.location.href = "/";
    }
  };

  return (
    <div
      id="phoneDevice"
      className={`fixed inset-0 bg-printgo-green text-printgo-paper flex flex-col items-center justify-center font-sans p-4 md:p-6 text-center overflow-hidden z-50 select-none ${
        isPriority ? "priority-chassis-active" : "border border-slate-900/40"
      }`}
      style={{
        background:
          "radial-gradient(circle at 50% 28%, #187949 0%, #13663c 45%, #0e4e2e 100%)",
        boxShadow: isPriority
          ? "0 0 18px rgba(250, 204, 21, 0.45), 0 0 38px rgba(245, 158, 11, 0.25), inset 0 0 14px rgba(250, 204, 21, 0.2)"
          : undefined,
        borderColor: isPriority ? "#FACC15" : undefined,
      }}
    >
      <style>{journeyCss}</style>

      {/* Animated Golden Electric Perimeter Border (Priority Orders) */}
      {isPriority && (
        <div
          className="priority-perimeter-border-shell pointer-events-none absolute inset-0 z-40 overflow-hidden"
          aria-hidden="true"
        >
          {/* Rotating Conic Electric Current Runner (6.0s medium speed) */}
          <div className="priority-perimeter-runner absolute inset-0" />

          {/* Periodic Subtle Electric Lightning Discharges (500ms - 800ms) */}
          <div className="priority-perimeter-crackle priority-crackle-top" />
          <div className="priority-perimeter-crackle priority-crackle-bottom" />
          <div className="priority-perimeter-crackle priority-crackle-left" />
          <div className="priority-perimeter-crackle priority-crackle-right" />
        </div>
      )}
      {/* Top Left Back Button */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          paddingTop: "max(env(safe-area-inset-top, 16px), 16px)",
          paddingLeft: "16px",
          zIndex: 60,
        }}
      >
        <button
          type="button"
          onClick={handleBackAction}
          aria-label="Back"
          className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:bg-white/30 border border-white/25 backdrop-blur-md text-white transition-all shadow-sm active:scale-95 cursor-pointer"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
      </div>

      {/* Top Right Print Another Button */}
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          paddingTop: "max(env(safe-area-inset-top, 16px), 16px)",
          paddingRight: "16px",
          zIndex: 60,
        }}
      >
        <button
          type="button"
          onClick={handleBackAction}
          aria-label="Print another"
          className="inline-flex flex-row items-center gap-2 px-3.5 py-1.5 md:px-4 md:py-2 rounded-full bg-white/10 hover:bg-white/20 active:bg-white/30 border border-white/30 backdrop-blur-md text-white text-xs md:text-sm font-semibold transition-all shadow-sm active:scale-95 cursor-pointer whitespace-nowrap shrink-0"
          style={{
            touchAction: "manipulation",
            whiteSpace: "nowrap",
          }}
        >
          <RefreshCw className="w-3.5 h-3.5 md:w-4 md:h-4 stroke-[2.4] shrink-0" />
          <span className="whitespace-nowrap leading-none">Print another</span>
        </button>
      </div>

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white/5 pointer-events-none flex justify-center items-center">
        <CheckCircle2
          className="w-[240px] h-[240px] md:w-[600px] md:h-[600px] lg:w-[800px] lg:h-[800px]"
          strokeWidth={0.5}
        />
      </div>

      <motion.div
        initial={reduceMotion ? false : { opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="flex flex-col items-center justify-center relative z-10 w-full max-w-[85%] md:max-w-md mx-auto my-auto"
      >
        <div className="bg-white rounded-full p-2.5 md:p-4 mb-3 md:mb-5 shadow-xl flex items-center justify-center w-14 h-14 md:w-16 md:h-16 shrink-0">
          <Check
            className="w-7 h-7 md:w-8 md:h-8"
            strokeWidth={3.5}
            color="#146b41"
            style={{ stroke: "#146b41" }}
          />
        </div>

        <div className="flex items-center justify-center gap-2 mb-1.5 md:mb-2">
          {isPriority && (
            <svg
              className="w-6 h-6 md:w-7 md:h-7 thunder-icon-active shrink-0"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
                fill="#F59E0B"
                stroke="#B45309"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <h1
            className="font-serif text-3xl md:text-5xl lg:text-6xl font-medium tracking-tight leading-tight text-printgo-dark"
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
            }}
          >
            Ready for pickup
          </h1>
        </div>

        <p className="text-white text-xs md:text-lg mb-5 md:mb-10 font-medium text-white/[0.92]">
          Your order is printed, finished, and waiting.
        </p>

        {/* Frosted Translucent Card: Clean white/translucent border containing only the pickup code */}
        <div className="border-[2px] border-white/30 bg-white/10 rounded-[1.25rem] md:rounded-[1.5rem] p-5 md:p-10 w-full shadow-2xl backdrop-blur-md">
          <p className="text-white text-[10px] md:text-sm uppercase tracking-widest font-bold mb-2 md:mb-4">
            {orderDetails.pickupCode ? "Pickup code" : "Order code"}
          </p>
          <div
            className="text-4xl md:text-7xl font-mono font-bold tracking-widest mb-4 md:mb-8 text-white"
            style={{
              fontSize: "clamp(1.5rem, 8vw, 4.5rem)",
              overflowWrap: "anywhere",
              fontFeatureSettings: "'zero' 0",
            }}
          >
            {activeCode}
          </div>
          <div className="h-px bg-white/20 w-full mb-3 md:mb-4" />
          <p className="text-white/80 text-xs md:text-sm font-medium tracking-wide">
            Take a screenshot or remember this code for pickup
          </p>
        </div>

        {/* Down of the pickup code card in light gold when priority is selected */}
        {isPriority && (
          <div className="mt-4 md:mt-6 flex items-center justify-center gap-2 text-[14px] md:text-[16px] font-bold tracking-wide text-[#FDE047] drop-shadow-sm">
            <span className="text-[#FBBF24] text-base md:text-lg shrink-0">
              ⚡
            </span>
            <span className="leading-tight">
              Thanks for being our premium customer
            </span>
          </div>
        )}
      </motion.div>
    </div>
  );
}
