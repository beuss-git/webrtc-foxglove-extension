import { PanelExtensionContext, SettingsTreeAction, SettingsTreeNodes } from "@foxglove/extension";
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { set } from "lodash";
import { createRoot } from "react-dom/client";
import { produce } from "immer";
import Janus, { JanusJS } from "janus-gateway";
import adapter from "webrtc-adapter";

enum ConnectionState {
  DISCONNECTED = "Not connected",
  INITIALIZING = "Initializing Janus...",
  CONNECTING = "Connecting to Janus server...",
  ATTACHING = "Attaching to streaming plugin...",
  WATCHING = "Starting stream...",
  CONNECTED = "Connected",
  STOPPED = "Stream stopped",
  DESTROYED = "Connection destroyed"
}

type ConnectionError = {
  source: "janus" | "plugin" | "webrtc" | "playback" | "stream",
  message: string
}

type PanelState = {
  stream: {
    label: string;
    visible: boolean;
    serverUrl: string;
    streamId: number;
    debug: boolean;
  };
};

type JanusStreamState = {
  connectionState: ConnectionState;
  isConnected: boolean;
  error: ConnectionError | null;
  videoStats: {
    width: number;
    height: number;
    bitrate: string;
  } | null;
  shouldReconnect: boolean;
};

function JanusStreamPanel({ context }: { context: PanelExtensionContext }): JSX.Element {
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  const videoRef = useRef<HTMLVideoElement>(null);
  const janusRef = useRef<Janus | null>(null);
  const streamingRef = useRef<JanusJS.PluginHandle | null>(null);
  const bitrateTimerRef = useRef<number | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Panel settings state
  const [state, setState] = useState<PanelState>(() => {
    const partialState = context.initialState as Partial<PanelState>;
    return {
      stream: {
        label: partialState.stream?.label ?? "Janus Stream",
        visible: partialState.stream?.visible ?? true,
        serverUrl: partialState.stream?.serverUrl ?? "http://localhost:8088/janus",
        streamId: partialState.stream?.streamId ?? 1,
        debug: partialState.stream?.debug ?? false,
      },
    };
  });

  // Stream connection state
  const [streamState, setStreamState] = useState<JanusStreamState>({
    connectionState: ConnectionState.DISCONNECTED,
    isConnected: false,
    error: null,
    videoStats: null,
    shouldReconnect: false
  });

  const [logs, setLogs] = useState<Array<{ message: string, type: "info" | "error" | "warn" }>>([]);

  const log = useCallback((message: string, type: "info" | "error" | "warn" = "info") => {
    setLogs(prevLogs => [...prevLogs, { message, type }]);

    // Auto-scroll logs to bottom
    setTimeout(() => {
      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      }
    }, 0);
  }, []);

  const updateStreamState = useCallback((update: Partial<JanusStreamState>) => {
    setStreamState(currentState => {
      const newState = {
        ...currentState,
        ...update
      };

      // Only log state change if it's actually different
      if (update.connectionState && update.connectionState !== currentState.connectionState) {
        log(`Connection state: ${update.connectionState}`, "info");
      }

      if (update.error && (!currentState.error ||
        update.error.message !== currentState.error.message ||
        update.error.source !== currentState.error.source)) {
        log(`Error (${update.error.source}): ${update.error.message}`, "error");
      }

      return newState;
    });
  }, [log]);

  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      if (action.action === "update") {
        const { path, value } = action.payload;

        setState(
          produce((draft) => {
            set(draft, path, value);
          })
        );

        if (path[1] === "serverUrl" || path[1] === "streamId") {
          log(`Settings changed, will reconnect with new ${path[1]}: ${value}`);
          updateStreamState({ shouldReconnect: true });
        }
      }
    },
    [log, updateStreamState],
  );

  // Update settings UI when state changes
  useEffect(() => {
    // Save state for persistence
    context.saveState(state);

    const nodes: SettingsTreeNodes = {
      stream: {
        label: state.stream.label,
        icon: "Cube",
        visible: state.stream.visible,
        renamable: true,
        fields: {
          serverUrl: {
            label: "Janus Server URL",
            input: "string",
            value: state.stream.serverUrl,
          },
          streamId: {
            label: "Stream ID",
            input: "number",
            value: state.stream.streamId,
          },
          debug: {
            label: "Debug Mode",
            input: "boolean",
            value: state.stream.debug,
          },
        },
        order: 1,
      }
    };

    // Update the settings panel
    context.updatePanelSettingsEditor({
      actionHandler,
      nodes,
    });
  }, [context, actionHandler, state]);

  const stopStream = useCallback(() => {
    if (!streamingRef.current) return;

    log("Stopping stream");

    if (videoRef.current) {
      const oldSrcObject = videoRef.current.srcObject;

      // Clear the video element first
      videoRef.current.pause();
      videoRef.current.srcObject = null;

      // Then remove tracks from the old stream if it exists
      if (oldSrcObject instanceof MediaStream) {
        const tracks = oldSrcObject.getTracks();
        tracks.forEach(track => {
          track.stop();
          oldSrcObject.removeTrack(track);
        });
      }
    }

    const body = { request: "stop" };
    streamingRef.current.send({ message: body });
    streamingRef.current.hangup();

  }, [log]);

  const startStream = useCallback(() => {
    if (!streamingRef.current) {
      updateStreamState({
        connectionState: ConnectionState.DISCONNECTED,
        error: { source: "plugin", message: "Streaming plugin not initialized" }
      });
      return;
    }

    updateStreamState({ connectionState: ConnectionState.WATCHING });
    const body = { request: "watch", id: state.stream.streamId };
    streamingRef.current.send({ message: body });
  }, [state.stream.streamId, updateStreamState]);

  const cleanupJanus = useCallback(() => {
    log("Cleaning up Janus resources");

    // Clean up the bitrate timer
    if (bitrateTimerRef.current) {
      clearInterval(bitrateTimerRef.current);
      bitrateTimerRef.current = null;
    }

    if (janusRef.current) {
      try {
        if (typeof janusRef.current.isConnected === 'function' && janusRef.current.isConnected()) {
          log("Forcing Janus disconnection before cleanup");
        }

        janusRef.current.destroy({
          unload: true,  // Unload everything
          notifyDestroyed: false,  // Don't trigger the destroyed callback to avoid race conditions
          cleanupHandles: true
        });
      } catch (err) {
        log(`Error during Janus cleanup: ${err}`, "warn");
      }
      janusRef.current = null;
    }

    streamingRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current.load(); // Force video element to reset
    }

    updateStreamState({
      connectionState: ConnectionState.DISCONNECTED,
      isConnected: false,
      videoStats: null
    });
  }, [log, updateStreamState]);

  const initJanusConnection = useCallback(() => {
    // Ensure we're starting with a clean state - don't call cleanupJanus here
    // as it may have just been called and we want to avoid redundant operations

    log("Initializing new Janus connection");
    updateStreamState({
      connectionState: ConnectionState.CONNECTING,
      isConnected: false,
      error: null,
    });

    janusRef.current = new Janus({
      server: state.stream.serverUrl,
      iceServers: [],

      // Success callback when connected to Janus server
      success: function () {
        log("Connected to Janus server, attaching plugin");
        updateStreamState({ connectionState: ConnectionState.ATTACHING });

        janusRef.current?.attach({
          plugin: "janus.plugin.streaming",
          opaqueId: "foxglovestreamingtest-" + Janus.randomString(12),

          // Success callback when plugin is attached
          success: function (pluginHandle) {
            log("Successfully attached to streaming plugin");
            streamingRef.current = pluginHandle;
            startStream();
          },

          // Error callback for plugin attachment
          error: function (error: any) {
            updateStreamState({
              connectionState: ConnectionState.DISCONNECTED,
              error: { source: "plugin", message: String(error) }
            });
          },

          // Handle incoming messages from Janus
          onmessage: function (msg: any, jsep: any) {
            if (msg["error"]) {
              updateStreamState({
                error: { source: "stream", message: msg["error"] }
              });
              return;
            }

            // Handle session description protocol offer
            if (jsep && streamingRef.current) {
              streamingRef.current.createAnswer({
                jsep: jsep,
                tracks: [{ type: 'data', capture: false }],
                media: { audioSend: false, videoSend: false },

                // Success callback for answer creation
                success: function (jsep: any) {
                  if (streamingRef.current) {
                    const body = { request: "start" };
                    streamingRef.current.send({ message: body, jsep: jsep });
                  }
                },

                // Error callback for WebRTC negotiation
                error: function (error: any) {
                  updateStreamState({
                    connectionState: ConnectionState.DISCONNECTED,
                    error: { source: "webrtc", message: error.message || String(error) }
                  });
                }
              });
            }
          },

          // Handle incoming media tracks
          onremotetrack: function (track: MediaStreamTrack, mid: string, on: boolean) {
            if (!on) {
              if (track.kind === "video") {
                updateStreamState({
                  connectionState: ConnectionState.STOPPED,
                  isConnected: false,
                  videoStats: null
                });

                if (bitrateTimerRef.current) {
                  clearInterval(bitrateTimerRef.current);
                  bitrateTimerRef.current = null;
                }
              }
              log("Track " + track.id + " is off, skipping processing");
              return;
            }

            if (track.kind === "video") {
              log("Received video track: " + track.id);

              // Use a single MediaStream instance and add/remove tracks as needed
              // This prevents "interrupted by new load request" errors
              if (!videoRef.current!.srcObject) {
                const stream = new MediaStream();
                Janus.attachMediaStream(videoRef.current!, stream);
              }

              // Get the existing stream and add the new track
              const stream = videoRef.current!.srcObject as MediaStream;

              // Remove any existing video tracks to avoid conflicts
              const existingVideoTracks = stream.getVideoTracks();
              existingVideoTracks.forEach(t => stream.removeTrack(t));

              // Add the new track to the stream
              stream.addTrack(track);

              // Only attempt to play if we haven't successfully connected yet
              if (!streamState.isConnected) {
                log("Playing video track: " + track.id);
                // Use a small timeout to let the browser process the new track
                setTimeout(() => {
                  if (videoRef.current) {
                    videoRef.current.play()
                      .then(function () {
                        updateStreamState({
                          connectionState: ConnectionState.CONNECTED,
                          isConnected: true,
                          error: null
                        });

                        if (bitrateTimerRef.current === null) {
                          const updateBitrate = () => {
                            if (videoRef.current && videoRef.current.videoWidth && streamingRef.current) {
                              try {
                                const bitrate = streamingRef.current.getBitrate(mid);
                                updateStreamState({
                                  videoStats: {
                                    width: videoRef.current.videoWidth,
                                    height: videoRef.current.videoHeight,
                                    bitrate
                                  }
                                });
                              } catch (e) {
                                log("Error getting bitrate: " + String(e), "warn");
                              }
                            }
                          };

                          updateBitrate();

                          bitrateTimerRef.current = window.setInterval(updateBitrate
                            , 1000);
                        }
                      })
                      .catch(function (error: any) {
                        // If it's just the interrupted error, we can ignore it as we'll try again
                        if (error.message && error.message.includes('interrupted by a new load request')) {
                          log("Play interrupted, will retry automatically", "warn");
                        } else {
                          updateStreamState({
                            connectionState: ConnectionState.DISCONNECTED,
                            error: { source: "playback", message: error.message || String(error) }
                          });
                        }
                      });
                  } else {
                    log("Video element not found, cannot play track", "error");
                  }
                }, 100);
              }

            }
          },

          // Cleanup callback when stream ends
          oncleanup: function () {
            if (bitrateTimerRef.current) {
              clearInterval(bitrateTimerRef.current);
              bitrateTimerRef.current = null;
            }

            if (videoRef.current) {
              videoRef.current.srcObject = null;
            }

            updateStreamState({
              connectionState: ConnectionState.STOPPED,
              isConnected: false,
              videoStats: null
            });
          }
        });
      },

      // Error callback for Janus connection
      error: function (error: any) {
        updateStreamState({
          connectionState: ConnectionState.DISCONNECTED,
          error: { source: "janus", message: String(error) }
        });
      },

      // Destroyed callback when Janus instance is terminated
      destroyed: function () {
        updateStreamState({
          connectionState: ConnectionState.DESTROYED,
          isConnected: false,
          videoStats: null
        });
      }
    });
  }, [state.stream.serverUrl, startStream, updateStreamState, cleanupJanus, log]);

  // Initialize Janus when component mounts
  useEffect(() => {
    updateStreamState({ connectionState: ConnectionState.INITIALIZING });

    const setupJanusLogHandlers = () => {
      // Custom log handler to override Janus internal debugging
      Janus.log = (...args) => {
        if (state.stream.debug) {
          log(`[Janus] ${args.join(' ')}`, "info");
        }
      };

      Janus.error = (...args) => {
        log(`[Janus Error] ${args.join(' ')}`, "error");
      };

      Janus.warn = (...args) => {
        if (state.stream.debug) {
          log(`[Janus Warning] ${args.join(' ')}`, "warn");
        }
      };
    };


    // Initialize Janus library with proper error handling
    try {
      Janus.init({
        dependencies: Janus.useDefaultDependencies({ adapter: adapter }),
        debug: state.stream.debug ? "all" : false,
        callback: () => {

          setupJanusLogHandlers();

          log("Janus library initialized");
          initJanusConnection();
        }
      });
    } catch (error) {
      log(`Failed to initialize Janus library: ${error}`, "error");
      updateStreamState({
        connectionState: ConnectionState.DISCONNECTED,
        error: { source: "janus", message: String(error) }
      });
    }

    return () => {
      cleanupJanus();
    };
  }, [initJanusConnection, cleanupJanus, state.stream.debug, log, updateStreamState]);

  // Handle reconnection when settings change
  useEffect(() => {
    if (streamState.shouldReconnect) {
      log("Reconnecting due to settings change");

      updateStreamState({ shouldReconnect: false });

      stopStream();

      let timeout: number;
      let reconnectTimeout: number;

      timeout = window.setTimeout(() => {
        cleanupJanus();

        reconnectTimeout = window.setTimeout(() => {
          initJanusConnection();
        }, 1000);
      }, 500);

      return () => {
        window.clearTimeout(timeout);
        if (reconnectTimeout) {
          window.clearTimeout(reconnectTimeout);
        }
      };
    }

    return () => { };
  }, [streamState.shouldReconnect, stopStream, cleanupJanus, initJanusConnection, log, updateStreamState]);

  // Handle manual restart stream
  const handleRestartStream = useCallback(() => {
    log("Manual stream restart requested");

    stopStream();

    // Give time for the stream to stop properly
    setTimeout(() => {
      log("Performing full Janus reconnection");
      cleanupJanus();

      // Wait for cleanup to complete before initializing the new connection
      setTimeout(() => {
        initJanusConnection();
      }, 1000);
    }, 500);
  }, [initJanusConnection, stopStream, cleanupJanus, log]);

  useLayoutEffect(() => {
    context.onRender = (_renderState, done) => {
      setRenderDone(() => done);
    };
  }, [context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  // Styles
  const containerStyle = {
    height: '100%',
    width: '100%',
    position: 'relative' as const,
    backgroundColor: '#000',
    display: 'flex',
    flexDirection: 'column' as const,
  };

  const videoStyle = {
    width: '100%',
    height: '100%',
    objectFit: 'contain' as const,
  };

  const statsStyle = {
    position: 'absolute' as const,
    bottom: '10px',
    left: '10px',
    color: 'white',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: '5px 10px',
    borderRadius: '4px',
    fontFamily: 'monospace',
    fontSize: '12px',
    zIndex: 10,
  };

  const buttonStyle = {
    position: 'absolute' as const,
    bottom: '10px',
    right: '10px',
    backgroundColor: 'rgba(0,0,0,0.5)',
    color: 'white',
    border: 'none',
    padding: '5px 10px',
    borderRadius: '4px',
    cursor: 'pointer',
    zIndex: 10,
  };

  const overlayStyle = {
    position: 'absolute' as const,
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    color: 'white',
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: '10px 20px',
    borderRadius: '4px',
    fontFamily: 'sans-serif',
    display: streamState.isConnected ? 'none' : 'block',
    zIndex: 5,
  };

  const logContainerStyle = {
    position: 'absolute' as const,
    top: '10px',
    right: '10px',
    width: '300px',
    maxHeight: '200px',
    backgroundColor: 'rgba(0,0,0,0.7)',
    color: 'white',
    padding: '10px',
    borderRadius: '4px',
    fontFamily: 'monospace',
    fontSize: '11px',
    overflowY: 'auto' as const,
    zIndex: 20,
    display: state.stream.debug ? 'block' : 'none',
  };

  const logEntryStyle = (type: "info" | "error" | "warn") => ({
    margin: '3px 0',
    color: type === "error" ? '#ff6b6b' : type === "warn" ? '#feca57' : '#dfe6e9',
    wordBreak: 'break-word' as const,
  });

  return (
    <div style={containerStyle}>
      <video ref={videoRef} style={videoStyle} autoPlay playsInline muted></video>

      {/* Stats display */}
      {streamState.videoStats && (
        <div style={statsStyle}>
          Resolution: {streamState.videoStats.width}x{streamState.videoStats.height} |
          Bitrate: {streamState.videoStats.bitrate}
        </div>
      )}

      {/* Restart button */}
      <button style={buttonStyle} onClick={handleRestartStream}>Restart</button>

      {/* Connection status overlay */}
      <div style={overlayStyle}>
        {streamState.error
          ? `${streamState.connectionState}: ${streamState.error.message}`
          : streamState.connectionState
        }
      </div>

      {/* Log display */}
      <div ref={logContainerRef} style={logContainerStyle}>
        {logs.map((log, index) => (
          <div key={index} style={logEntryStyle(log.type)}>
            {log.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export function initJanusStreamPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<JanusStreamPanel context={context} />);

  // Return a function to run when the panel is removed
  return () => {
    root.unmount();
  };
}
