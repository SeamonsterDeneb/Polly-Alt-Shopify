import { useEffect, useState, useRef } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { GoogleGenAI } from "@google/genai";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Query our database directly to find our custom field
  const dbSession = await prisma.session.findUnique({
    where: { id: session.id }
  });

  // Fetching the merchant's image files via Admin GraphQL
  const response = await admin.graphql(
    `#graphql
    query fetchShopifyFiles {
      files(first: 10, query: "file_type:IMAGE") {
        edges {
          node {
            id
            alt
            createdAt
            ... on MediaImage {
              image {
                url
              }
            }
          }
        }
      }
    }`
  );

  const responseJson = await response.json();
  
  return {
    files: responseJson.data?.files?.edges || [],
    hasApiKey: !!dbSession?.geminiApiKey // Read directly from our DB session
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // Save the Gemini API Key to the database session
  if (intent === "save-api-key") {
    const apiKey = formData.get("apiKey");
    if (!apiKey) {
      return { success: false, error: "API key cannot be empty." };
    }

    session.geminiApiKey = apiKey;
    await prisma.session.upsert({
      where: { id: session.id },
      update: { geminiApiKey: apiKey },
      create: {
        id: session.id,
        shop: session.shop,
        state: session.state,
        accessToken: session.accessToken,
        geminiApiKey: apiKey,
      },
    });

    return { success: true, keySaved: true };
  }

  // Active Gemini AI Multimodal Analysis
  if (intent === "analyze-image") {
    const imageUrl = formData.get("imageUrl");
    const requestedModel = formData.get("model") || "gemini-3.5-flash";

    // Pull the session directly from the DB so we get our custom field
    const dbSession = await prisma.session.findUnique({
      where: { id: session.id }
    });
    const savedApiKey = dbSession?.geminiApiKey;
    
    const targetCount = 3; 

    if (!savedApiKey) {
      return { success: false, error: "Missing API Key. Please save a Gemini Key first." };
    }

    try {
      const imageResponse = await fetch(imageUrl);
      const arrayBuffer = await imageResponse.arrayBuffer();
      const base64Image = Buffer.from(arrayBuffer).toString("base64");
      const mimeType = imageResponse.headers.get("content-type") || "image/jpeg";

      const ai = new GoogleGenAI({ apiKey: savedApiKey });

      const response = await ai.models.generateContent({
        model: requestedModel,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `You are Polly, an expert e-commerce alt text optimization assistant.
Analyze the provided image and generate exactly ${targetCount} alternative descriptions.

CRITICAL LAWS FOR COMPLIANCE:
1. HARD CEILING: Each description MUST be strictly under 125 characters total. Do not exceed this limit under any circumstances.
2. Put the primary focal subject first.
3. Highlight a DIFFERENT aspect or focal point for each of the ${targetCount} options.
4. Return the data as a clean, valid JSON array of objects with keys: 'alt', 'focus', and 'explanation'.

DO NOT include any markdown blocks or extra text, just raw JSON.`
              },
              {
                inlineData: {
                  data: base64Image,
                  mimeType: mimeType
                }
              }
            ]
          }
        ]
      });

      // Parse the response cleanly
      const responseText = response.text || "";
      const rawText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
      const suggestions = JSON.parse(rawText);

      return { success: true, suggestions };

    } catch (error) {
      console.error("Gemini analysis execution failed:", error);
      
      const errMsg = error.message || "";
      if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("Quota exceeded")) {
        return { 
          success: false, 
          error: "Quota Exceeded! The selected model requires active Google Cloud Billing details to be configured in your Google AI Studio console. Please switch back to a standard Free-Tier model (like Gemini 3.5 Flash) or add a billing method to your Gemini API key profile." 
        };
      }
      
      // DIAGNOSTIC UPDATE: Pass the raw error object text straight back to our error component alert box
      return { 
        success: false, 
        error: `Polly Engine Stalled: ${error.toString()} | Message: ${error.message || "Unknown error context"}` 
      };
    }
  }

  if (intent === "save-alt") {
    const fileId = formData.get("fileId");
    const newAltText = formData.get("altText");

    try {
      const response = await admin.graphql(
        `#graphql
        mutation updateFileAlt($input: FileUpdateInput!) {
          fileUpdate(files: [$input]) {
            files {
              id
              alt
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input: {
              id: fileId,
              alt: newAltText,
            },
          },
        }
      );

      const responseJson = await response.json();
      return { 
        success: true, 
        updatedFile: responseJson?.data?.fileUpdate?.files?.[0] || null 
      };
    } catch (error) {
      console.error("Error updating alt text via GraphQL:", error);
      return { success: false, error: "Failed to save alt text." };
    }
  }

  return null;
};

export default function Index() {
  const { files, hasApiKey } = useLoaderData(); 
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const [selectedModel, setSelectedModel] = useState("gemini-3.5-flash");
  const [errorMessage, setErrorMessage] = useState(null); // Persistent structural warning states

  // Helper properties to calculate our continuous asset deck pointers
  const currentFileNode = files[currentFileIndex]?.node || null;

  const handleOpenTriage = (index) => {
    console.log("Input index target triggered:", index);
    setCurrentFileIndex(index);
    setAiSuggestions([]); 
    setIsModalOpen(true);

    const targetFile = files[index]?.node;
    if (targetFile?.image?.url) {
      fetcher.submit(
        { intent: "analyze-image", imageUrl: targetFile.image.url, model: selectedModel },
        { method: "POST" }
      );
    }
  };

  const handleNextImage = (onlyMissing = false) => {
    let nextIndex = currentFileIndex + 1;
    
    if (onlyMissing) {
      while (nextIndex < files.length) {
        if (!files[nextIndex].node.alt) break;
        nextIndex++;
      }
    }

    if (nextIndex < files.length) {
      setCurrentFileIndex(nextIndex);
      setAiSuggestions([]); 

      const nextFile = files[nextIndex]?.node;
      if (nextFile?.image?.url) {
        fetcher.submit(
          { intent: "analyze-image", imageUrl: nextFile.image.url, model: selectedModel },
          { method: "POST" }
        );
      }
    } else {
      shopify.toast.show("End of media library reached!");
      setIsModalOpen(false);
    }
  };

  const handleApplyAlt = (altText) => {
    fetcher.submit(
      { intent: "save-alt", fileId: currentFileNode.id, altText: altText },
      { method: "POST" }
    );
    shopify.toast.show("Alt text updated successfully!");
  };

  // Listen to fetcher updates to dynamically sync the local file state list, key visibility, and AI results
  useEffect(() => {
    if (fetcher.data?.keySaved) {
      shopify.toast.show("Polly's Nest is ready!");
      window.location.reload();
    }

    // Capture the output suggestions from our secure server action
    if (fetcher.data?.suggestions) {
      setAiSuggestions(fetcher.data.suggestions);
    } else if (fetcher.data?.success === false) {
      console.error("🦜 POLLY FETCH ERROR:", fetcher.data.error);
      setErrorMessage(fetcher.data.error); // Populate persistent error layout container
    }

    if (fetcher.data?.success && fetcher.data?.updatedFile) {
      const updated = fetcher.data.updatedFile;
      const fileIndex = files.findIndex(f => f.node.id === updated.id);
      if (fileIndex !== -1) {
        files[fileIndex].node.alt = updated.alt;
      }
    }
  }, [fetcher.data]);

  return (
    <s-page heading="Polly Alt — Media Triage Workspace" inline-size="large">
      
      {/* 1. Interactive Gemini Key Setup Banner */}
      {!hasApiKey && (
        <div style={{ marginBottom: "24px" }}>
          <s-box padding="base" background="subdued" borderWidth="base" borderColor="warning" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-heading type="strong">🦜 Complete Polly's Nest Setup</s-heading>
              <s-text>
                To generate free alt text optimizations, Polly needs a Google Gemini API Key. Keys are 100% free and stored securely on your server.
              </s-text>
              <s-link href="https://aistudio.google.com/" target="_blank">
                Get a free Gemini API Key from Google AI Studio ➜
              </s-link>
              
              <div style={{ display: "flex", gap: "10px", marginTop: "10px", maxWidth: "500px" }}>
                <input 
                  type="password" 
                  name="apiKey" 
                  placeholder="Paste your API key here (AI_sy...)" 
                  id="gemini-api-input"
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    border: "1px solid #babfc3",
                    borderRadius: "4px",
                    fontSize: "14px"
                  }}
                />
                <s-button 
                  variant="primary"
                  onClick={() => {
                    const keyVal = document.getElementById("gemini-api-input")?.value;
                    if (keyVal) {
                      fetcher.submit(
                        { intent: "save-api-key", apiKey: keyVal },
                        { method: "POST" }
                      );
                      shopify.toast.show("Saving API Key...");
                    }
                  }}
                >
                  Save Key
                </s-button>
              </div>
            </s-stack>
          </s-box>
        </div>
      )}

      <s-section heading="Library Health Metrics">
        <s-text>
          Welcome back to the roost! Select any image below to preview status and generate accessible descriptions.
        </s-text>
      </s-section>

      <s-grid columns="1" md-columns="3" gap="base">
        {/* Left Section: Active Media Selection Stack */}
        <s-grid-item span="2">
          <s-section heading="Images Requiring Attention">
            <s-stack direction="block" gap="base">
              {files.length === 0 ? (
                <s-paragraph>No images found. Go add some items to your store Content > Files library first!</s-paragraph>
              ) : (
                files.map((edge) => {
                  const file = edge.node;
                  return (
                    <s-box 
                      key={file.id} 
                      padding="base" 
                      borderWidth="base" 
                      borderColor="base" 
                      borderRadius="base"
                      background="base"
                    >
                      <s-stack direction="inline" gap="base" alignItems="center">
                        <img 
                          src={file.image?.url} 
                          alt={file.alt || "Preview Asset"} 
                          style={{ width: "80px", height: "80px", objectFit: "cover", borderRadius: "4px" }} 
                        />
                        <s-stack direction="block" gap="small-100">
                          <s-text type="strong">Current Alt text:</s-text>
                          <s-text color={file.alt ? "default" : "critical"}>
                            {file.alt || "⚠️ Missing Alternative Description"}
                          </s-text>
                          <s-button 
                            variant="primary" 
                            onClick={() => handleOpenTriage(files.indexOf(edge))}
                          >
                            Preview and Generate
                          </s-button>
                        </s-stack>
                      </s-stack>
                    </s-box>
                  );
                })
              )}
            </s-stack>
          </s-section>
        </s-grid-item>

        {/* Right Section: Multi-Option Choice Panel Mockup */}
        <s-grid-item>
          <s-section heading="Polly Suggestion Deck">
            <s-box padding="base" background="subdued" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-heading>No Active Selection</s-heading>
                <s-paragraph>
                  Click "Analyze Image" on an item to run Gemini processing optimization choices in this window.
                </s-paragraph>
              </s-stack>
            </s-box>
          </s-section>
        </s-grid-item>
      </s-grid>

      {/* 3. Polly Alt Continuous Triage Slide-Deck Dialog with Custom Backdrop */}
      {isModalOpen && currentFileNode && (
        <div 
          onClick={() => setIsModalOpen(false)} // Close when clicking the backdrop
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            backgroundColor: "rgba(0, 0, 0, 0.65)", // Dark semi-transparent overlay
            backdropFilter: "blur(4px)", // Blurs the workspace behind the modal
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }}
        >
          <div 
            onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside the dialog
            style={{
              width: "85vw",
              maxWidth: "800px",
              height: "80vh",
              borderRadius: "8px",
              boxShadow: "0px 20px 50px rgba(0, 0, 0, 0.3)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              background: "#fff",
              border: "1px solid #babfc3"
            }}
          >
            {/* Cinema-Style Top Scrollable View Window Frame */}
            <div style={{ 
              width: "100%", 
              height: "35vh", 
              overflowY: "auto", 
              background: "#111", 
              flexShrink: 0,
              display: "block"
            }}>
              <img 
                src={currentFileNode.image?.url} 
                alt="" 
                style={{ width: "100%", height: "auto", display: "block" }} 
              />
            </div>

            {/* Scrollable Choice & Action Workspace Area */}
            <div style={{
              flex: 1, 
              overflowY: "auto", 
              padding: "20px",
              background: "#fff"
            }}>
              <s-stack direction="block" gap="base">
                
                {/* Current Text Allocation Context block */}
                <s-box padding="base" background="subdued" borderRadius="base" borderWidth="base">
                  <s-stack direction="block" gap="small-100">
                    <s-text type="strong">ORIGINAL DRAFT:</s-text>
                    <s-text>{currentFileNode.alt || "None (Currently Empty)"}</s-text>
                  </s-stack>
                </s-box>

                {/* Dynamic Gemini Engine Selection Dropdown */}
                <div style={{ display: "flex", gap: "12px", alignItems: "center", margin: "8px 0" }}>
                  <s-text type="strong">Optimization Intelligence:</s-text>
                  <select 
                    value={selectedModel}
                    onChange={(e) => {
                      setSelectedModel(e.target.value);
                      fetcher.submit(
                        { intent: "analyze-image", imageUrl: currentFileNode.image?.url, model: e.target.value },
                        { method: "POST" }
                      );
                    }}
                    style={{
                      padding: "6px 12px",
                      border: "1px solid #babfc3",
                      borderRadius: "4px",
                      fontSize: "14px",
                      background: "#fff",
                      cursor: "pointer"
                    }}
                  >
                    <option value="gemini-3.5-flash">Gemini 3.5 Flash (Standard Default)</option>
                    <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite (Eco Speed)</option>
                    <option value="gemini-2.5-pro">Gemini 2.5 Pro (Requires Paid Billing)</option>
                  </select>
                </div>

                {/* Interactive Option Cards Selection Track Layout */}
                <s-heading>Polly Suggested Formats</s-heading>
                <s-stack direction="block" gap="base">
                  
                  {/* Visual loading indicator card while Gemini is analyzing */}
                  {fetcher.state === "submitting" && (
                    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                      <s-stack direction="inline" gap="base" alignItems="center">
                        <div className="spinner" style={{
                          border: "3px solid #f3f3f3",
                          borderTop: "3px solid #3498db",
                          borderRadius: "50%",
                          width: "20px",
                          height: "20px",
                          animation: "spin 1s linear infinite"
                        }} />
                        <s-text>Polly is studying your image details...</s-text>
                      </s-stack>
                    </s-box>
                  )}

                  {/* Display Live suggestions once loaded */}
                  {fetcher.state !== "submitting" && !errorMessage && aiSuggestions.length > 0 ? (
                    aiSuggestions.map((choice, i) => (
                      <s-box key={i} padding="base" borderWidth="base" borderRadius="base" background="base">
                        <s-stack direction="block" gap="small-100">
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontWeight: "bold", color: "#008060" }}>AI OPTION {i + 1}</span>
                            <span style={{ color: "#6d7175", fontSize: "13px" }}>({choice.alt.length} characters)</span>
                          </div>
                          <s-text>{choice.alt}</s-text>
                          <s-text type="italic" color="subdued">Focus: {choice.focus} — {choice.explanation}</s-text>
                          <s-button 
                            variant="secondary" 
                            onClick={() => handleApplyAlt(choice.alt)}
                          >
                            Apply This Option
                          </s-button>
                        </s-stack>
                      </s-box>
                    ))
                  ) : (
                    fetcher.state !== "submitting" && !errorMessage && (
                      <s-text color="subdued">No suggestions loaded yet. Click an option to generate.</s-text>
                    )
                  )}

                  {/* Persistent Error Message Container Box */}
                  {errorMessage && (
                    <s-box padding="base" background="subdued" borderWidth="base" borderColor="critical" borderRadius="base">
                      <s-stack direction="block" gap="base">
                        <s-text type="strong" color="critical">⚠️ Engine Error Notice</s-text>
                        <s-text>{errorMessage}</s-text>
                        <div>
                          <s-button onClick={() => setErrorMessage(null)}>Dismiss & Clear</s-button>
                        </div>
                      </s-stack>
                    </s-box>
                  )}
                </s-stack>

                <hr style={{ border: "none", borderTop: "1px solid #e1e3e5", margin: "16px 0" }} />

                {/* Flow Control Slide Bar */}
                <s-stack direction="inline" justify="space-between" alignItems="center">
                  <s-button variant="tertiary" onClick={() => setIsModalOpen(false)}>Close Deck</s-button>
                  <s-stack direction="inline" gap="base">
                    <s-button onClick={() => handleNextImage(false)}>Next Image ➜</s-button>
                    <s-button variant="primary" onClick={() => handleNextImage(true)}>Next Missing Alt ➜</s-button>
                  </s-stack>
                </s-stack>

              </s-stack>
            </div>
          </div>
        </div>
      )}

    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
