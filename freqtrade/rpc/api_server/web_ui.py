from pathlib import Path

from fastapi import APIRouter
from fastapi.exceptions import HTTPException
from starlette.responses import FileResponse


router_ui = APIRouter(include_in_schema=False, tags=["Web UI"])


@router_ui.get("/favicon.ico")
async def favicon():
    return FileResponse(str(Path(__file__).parent / "ui/favicon.ico"))


@router_ui.get("/fallback_file.html")
async def fallback():
    return FileResponse(str(Path(__file__).parent / "ui/fallback_file.html"))


@router_ui.get("/ui_version")
async def ui_version():
    from freqtrade.commands.deploy_ui import read_ui_version

    uibase = Path(__file__).parent / "ui/installed/"
    version = read_ui_version(uibase)

    return {
        "version": version if version else "not_installed",
    }


@router_ui.get("/dashboard")
@router_ui.get("/dashboard/")
async def dashboard_index():
    """Serve the redesigned standalone dashboard SPA."""
    return FileResponse(str(Path(__file__).parent / "dashboard/index.html"))


@router_ui.get("/dashboard/{asset_path:path}")
async def dashboard_assets(asset_path: str):
    """
    Serve static assets for the redesigned dashboard, with directory-traversal
    protection. Unknown paths fall back to index.html (SPA routing).
    """
    dashboard_base = (Path(__file__).parent / "dashboard").resolve()
    requested = (dashboard_base / asset_path).resolve()
    # It's security relevant to check "relative_to" to prevent directory traversal.
    if not requested.is_relative_to(dashboard_base):
        raise HTTPException(status_code=404, detail="Not Found")
    media_type: str | None = None
    if requested.suffix == ".js":
        # Force text/javascript for .js files - circumvent faulty system configuration
        media_type = "application/javascript"
    if requested.is_file():
        return FileResponse(str(requested), media_type=media_type)
    return FileResponse(str(dashboard_base / "index.html"))


@router_ui.get("/{rest_of_path:path}")
async def index_html(rest_of_path: str):
    """
    Emulate path fallback to index.html.
    """
    if rest_of_path.startswith("api") or rest_of_path.startswith("."):
        raise HTTPException(status_code=404, detail="Not Found")
    uibase = (Path(__file__).parent / "ui/installed/").resolve()
    filename = (uibase / rest_of_path).resolve()
    # It's security relevant to check "relative_to".
    # Without this, Directory-traversal is possible.
    media_type: str | None = None
    if filename.suffix == ".js":
        # Force text/javascript for .js files - Circumvent faulty system configuration
        media_type = "application/javascript"
    if filename.is_file() and filename.is_relative_to(uibase):
        return FileResponse(str(filename), media_type=media_type)

    index_file = uibase / "index.html"
    if not index_file.is_file():
        return FileResponse(str(uibase.parent / "fallback_file.html"))
    # Fall back to index.html, as indicated by vue router docs
    return FileResponse(str(index_file))
