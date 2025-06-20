import prisma from '../config/prismaClient.js';
import Joi from 'joi';
import bcrypt from 'bcrypt';
import { generarPassword } from '../utils/passwordSecurity.js';


const ROL_COMPETIDOR_ID = 2;



const competidorSchema = Joi.object({
    nombre: Joi.string().min(2).max(50).required(),
    apellido: Joi.string().min(2).max(50).required(),
    correo_electronico: Joi.string().email().required(),
    carnet_identidad: Joi.string().min(5).max(20).required(),
    fecha_nacimiento: Joi.date().iso().required()
        .custom((value, helpers) => {
            const hoy = new Date();
            const edad = hoy.getFullYear() - value.getFullYear();
            const mes = hoy.getMonth() - value.getMonth();
            const dia = hoy.getDate() - value.getDate();


            const edadReal = (mes < 0 || (mes === 0 && dia < 0)) ? edad - 1 : edad;

            if (edadReal > 18) {
                return helpers.message('El competidor no debe tener más de 18 años');
            }

            if (edadReal < 9) {
                return helpers.message('El competidor debe tener al menos 9 años para competir');
            }

            return value;
        }, 'Restricción de edad'),
    colegio_id: Joi.number().integer().required(),
    provincia_id: Joi.number().integer().required(),
});



export const registrarCompetidor = async (data) => {
    const { error, value } = competidorSchema.validate(data);
    if (error) {
        throw new Error(`Datos inválidos: ${error.details[0].message}`);
    }

    const {
        nombre,
        apellido,
        correo_electronico,
        carnet_identidad,
        fecha_nacimiento,
        colegio_id,
        provincia_id,
    } = value;

    const existente = await prisma.usuario.findFirst({
        where: {
            OR: [
                { correo_electronico },
                { competidor: { carnet_identidad } },
            ],
        },
        include: { competidor: true },
    });

    if (existente) {
        throw new Error('Ya existe un usuario o competidor con ese correo o carnet');
    }


    const usuario = await prisma.usuario.create({
        data: {
            nombre,
            apellido,
            correo_electronico,
            rol_id: ROL_COMPETIDOR_ID,
            password: carnet_identidad,
        },
    });

    const competidor = await prisma.competidor.create({
        data: {
            usuario_id: usuario.id,
            carnet_identidad,
            fecha_nacimiento: new Date(fecha_nacimiento),
            colegio_id,
            provincia_id,
        },
        include: {
            colegio: true,
            provincia: {
                include: {
                    departamento: true,
                },
            },
            usuario: true,
        },
    });

    return {
        competidor,
        credenciales: {
            correo_electronico,
            contraseña: carnet_identidad,
        },
    };
};

export const obtenerSolicitudesDelCompetidor = async (usuarioId) => {
    const competidor = await prisma.competidor.findUnique({
        where: { usuario_id: usuarioId }
    });

    if (!competidor) {
        throw new Error('No se encontró el competidor.');
    }

    const inscripciones = await prisma.inscripcion_tutor.findMany({
        where: {
            inscripcion: {
                competidor_id: competidor.id
            }
        },
        include: {
            inscripcion: true,
            tutor: {
                include: {
                    usuario: true
                }
            }
        }
    });

    const agrupadas = {};

    for (const item of inscripciones) {
        const idIns = item.inscripcion_id;

        if (!agrupadas[idIns]) {
            agrupadas[idIns] = {
                inscripcionId: idIns,
                fecha: item.inscripcion.fecha_inscripcion,
                estado: item.inscripcion.estado_inscripcion,
                tutores: []
            };
        }

        agrupadas[idIns].tutores.push({
            nombre: item.tutor.usuario.nombre,
            apellido: item.tutor.usuario.apellido,
            aprobado: item.aprobado,
            fecha_aprobacion: item.fecha_aprobacion
        });
    }

    return Object.values(agrupadas);
};

const MOTIVOS_RECHAZO = {
    1: "Solicitud enviada por error",
    2: "El estudiante no tiene datos correctos",
    4: "No reconozco a esta estudiante",
    5: "El estudiante alició al tutor equivocado",
    6: "No autorizo su participación",
    7: "Otro motivo"
};

export const obtenerInscripcionesCompetidor = async (usuarioId) => {
    // Buscar el competidor asociado al usuario
    const competidor = await prisma.competidor.findUnique({
        where: { usuario_id: usuarioId }
    });

    if (!competidor) {
        throw new Error('No se encontró el competidor');
    }

    // Obtener todas las inscripciones del competidor con sus tutores
    const inscripciones = await prisma.inscripcion.findMany({
        where: { competidor_id: competidor.id },
        include: {
            area: true,
            categoria: {
                include: {
                    grado_min: {
                        include: {
                            nivel: true
                        }
                    }
                }
            },
            convocatoria: true,
            tutorInscripciones: true // Incluir las inscripciones de tutor para obtener motivos de rechazo
        },
        orderBy: { fecha_inscripcion: 'desc' }
    });

    // Formatear los datos para la respuesta
    return inscripciones.map(inscripcion => {
        // Buscar si hay algún rechazo en las inscripciones de tutor
        const rechazo = inscripcion.tutorInscripciones.find(ti =>
            !ti.aprobado && (ti.motivo_rechazo_id || ti.descripcion_rechazo)
        );

        let motivoRechazo = null;
        if (rechazo) {
            if (rechazo.motivo_rechazo_id === 7) {
                // Si es "Otro motivo", usar la descripción personalizada
                motivoRechazo = rechazo.descripcion_rechazo || "Otro motivo";
            } else if (rechazo.motivo_rechazo_id) {
                // Buscar en el array estático
                motivoRechazo = MOTIVOS_RECHAZO[rechazo.motivo_rechazo_id] || "Motivo no especificado";
            }
        }

        return {
            id: inscripcion.id,
            area: inscripcion.area?.nombre_area || 'No asignada',
            categoria: inscripcion.categoria?.nombre_categoria || 'No asignada',
            grado: inscripcion.categoria?.grado_min?.nombre_grado || 'No especificado',
            nivel: inscripcion.categoria?.grado_min?.nivel?.nombre_nivel || 'No especificado',
            convocatoria: inscripcion.convocatoria?.nombre_convocatoria || 'No asignada',
            fecha_inscripcion: inscripcion.fecha_inscripcion,
            estado: inscripcion.estado_inscripcion || 'Pendiente',
            fecha_estado: inscripcion.fecha_estado || null,
            motivo_rechazo: motivoRechazo // Nuevo campo con el motivo de rechazo
        };
    });
};

// Función auxiliar para obtener el mensaje de motivo por ID (opcional)
export const obtenerMotivoRechazo = (motivoId, descripcionPersonalizada = null) => {
    if (motivoId === 7) {
        return descripcionPersonalizada || "Otro motivo";
    }
    return MOTIVOS_RECHAZO[motivoId] || null;
};

// Función para obtener todos los motivos disponibles (útil para formularios)
export const obtenerTodosLosMotivos = () => {
    return Object.entries(MOTIVOS_RECHAZO).map(([id, mensaje]) => ({
        id: parseInt(id),
        mensaje
    }));
};