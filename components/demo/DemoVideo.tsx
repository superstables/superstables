"use client";

import { useEffect, useRef, useState } from "react";
import { demoPage } from "@/content/demo";

const v = demoPage.video;

/**
 * The demo recording in a native player: controls, no autoplay, metadata only until play.
 * The description paragraph (rendered by the page) is the accessible description; when the
 * file cannot be loaded a status line points the reader to it and to the file itself. A
 * failure that happens before hydration fires no event, so the mounted element is checked once.
 */
export default function DemoVideo({ descriptionId }: { descriptionId: string }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && (el.error !== null || el.networkState === HTMLMediaElement.NETWORK_NO_SOURCE)) setFailed(true);
  }, []);
  return (
    <>
      <div className="film-frame">
        <div className="film-stage">
          <video
            ref={ref}
            className="film-video"
            width={v.width}
            height={v.height}
            controls
            playsInline
            preload="metadata"
            poster={v.poster}
            aria-label={v.label}
            aria-describedby={descriptionId}
            onError={() => setFailed(true)}
            onLoadedData={() => setFailed(false)}
          >
            <source src={v.src} type={v.type} onError={() => setFailed(true)} />
            <p>
              {v.unsupported} <a href={v.src}>Open the video file</a> or read the description below.
            </p>
          </video>
        </div>
      </div>
      <p className="film-error" role="status" hidden={!failed}>
        {failed && (
          <>
            {v.unavailable}{" "}
            <a className="text-link" href={v.src}>
              {v.openFile}
            </a>
            .
          </>
        )}
      </p>
    </>
  );
}
